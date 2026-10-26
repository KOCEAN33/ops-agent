import { anthropic } from "@ai-sdk/anthropic";
import { timingSafeEqual } from "node:crypto";
import { readInstructions, runTurn, type AgentDeps } from "./agent";
import { parseWebhook } from "./alert";
import { loadConfig, type Config } from "./config";
import { gitopsTools } from "./gitops";
import { kubeTools } from "./kube";
import { lokiTools, promTools } from "./query";
import { TurnQueue } from "./queue";
import { Store } from "./store";
import type { ReadTool } from "./tools";

export interface ServerDeps {
  store: Store;
  token: string;
  // Starts the turns the store holds, a new one included.
  kick: () => void;
}

// Alertmanager sends the token through webhook_config.http_config.authorization.
// Any pod that reaches the Service can POST here, and a forged notification
// both spends credit and writes into a session's history.
function authorized(req: Request, token: string): boolean {
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function createHandler(d: ServerDeps) {
  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (req.method !== "POST" || pathname !== "/alertmanager") {
      return new Response(null, { status: 404 });
    }
    if (!authorized(req, d.token)) return new Response(null, { status: 401 });
    const n = parseWebhook(await req.json().catch(() => null));
    if (!n) return new Response(null, { status: 400 });
    const { sessionId, turnId } = d.store.noteFiring(n.key, n.firing, n.text);
    console.log(JSON.stringify({ msg: "alert group", ...n.key, sessionId, changed: turnId !== null }));
    if (turnId !== null) d.kick();
    // Alertmanager only needs to know the notification arrived. The turn is
    // stored before the response and runs after it, so a slow model never
    // times out the webhook and a crash never loses the turn.
    return Response.json(n.key, { status: 202 });
  };
}

// One threat raises alerts in many groups at once. The limit keeps their turns
// from all reserving the month's spend in the same minute.
const PARALLEL_TURNS = 4;
// The SDK already retries a failed call twice within seconds, so a turn that
// still fails waits for an outage to pass.
const RETRY_MS = 60_000;
const MAX_ATTEMPTS = 3;
// A call that writes MAX_OUTPUT_TOKENS takes a few minutes.
const STEP_TIMEOUT_MS = 10 * 60_000;

const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

async function readTools(c: Config, now: () => Date): Promise<Record<string, ReadTool>> {
  const k = c.kube;
  return {
    ...(k &&
      kubeTools({
        url: k.url,
        token: async () => (k.serviceAccount ? (await Bun.file(`${SERVICE_ACCOUNT}/token`).text()).trim() : null),
        ca: k.serviceAccount ? await Bun.file(`${SERVICE_ACCOUNT}/ca.crt`).text() : undefined,
      })),
    ...(c.prometheusUrl && promTools({ url: c.prometheusUrl, now })),
    ...(c.lokiUrl && lokiTools({ url: c.lokiUrl, now })),
    ...(c.gitopsDir && gitopsTools(c.gitopsDir)),
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const now = () => new Date();
  const agent: AgentDeps = {
    model: anthropic(config.model),
    price: config.price,
    turnCapUsd: config.turnCapUsd,
    monthlyCapUsd: config.monthlyCapUsd,
    store,
    instructions: async () => (config.instructionsDir ? readInstructions(config.instructionsDir) : ""),
    now,
    tools: await readTools(config, now),
    stepTimeoutMs: STEP_TIMEOUT_MS,
  };
  console.log(JSON.stringify({ msg: "tools", tools: Object.keys(agent.tools) }));

  const queue = new TurnQueue({
    store,
    run: (turn) => runTurn(agent, turn),
    now,
    limit: PARALLEL_TURNS,
    retryMs: RETRY_MS,
    maxAttempts: MAX_ATTEMPTS,
  });
  // Turns a crash or a restart cut short run again.
  queue.kick();

  const server = Bun.serve({
    port: config.port,
    // A notification is a few kilobytes. Bun's default allows 128 MB.
    maxRequestBodySize: 1024 * 1024,
    fetch: createHandler({ store, token: config.webhookToken, kick: () => queue.kick() }),
  });
  console.log(`listening on ${server.url}`);
}
