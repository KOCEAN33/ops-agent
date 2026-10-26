import { anthropic } from "@ai-sdk/anthropic";
import { timingSafeEqual } from "node:crypto";
import { readInstructions, runTurn, type AgentDeps } from "./agent";
import { parseWebhook } from "./alert";
import { loadConfig, type Config } from "./config";
import { gitopsTools } from "./gitops";
import { kubeTools } from "./kube";
import { lokiTools, promTools } from "./query";
import { redact } from "./redact";
import { Store } from "./store";
import type { ReadTool } from "./tools";

export interface ServerDeps {
  store: Store;
  token: string;
  startTurn: (sessionId: number, text: string) => void;
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
    const { sessionId, changed } = d.store.noteFiring(n.key, n.firing);
    console.log(JSON.stringify({ msg: "alert group", ...n.key, sessionId, changed }));
    if (changed) d.startTurn(sessionId, n.text);
    // Alertmanager only needs to know the notification arrived. The turn runs
    // after the response, so a slow model never times out the webhook.
    return Response.json(n.key, { status: 202 });
  };
}

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
  };
  console.log(JSON.stringify({ msg: "tools", tools: Object.keys(agent.tools) }));

  // Turns on one session run one after another, so each sees the last one's
  // messages. Different sessions run in parallel.
  const queues = new Map<number, Promise<void>>();
  const startTurn = (sessionId: number, text: string) => {
    const next = (queues.get(sessionId) ?? Promise.resolve())
      .then(() => runTurn(agent, sessionId, text))
      .then(
        (r) => console.log(JSON.stringify({ msg: "turn", sessionId, ...("text" in r ? { text: redact(r.text) } : r) })),
        (e) => console.error(JSON.stringify({ msg: "turn failed", sessionId, error: String(e) })),
      );
    queues.set(sessionId, next);
  };

  const server = Bun.serve({
    port: config.port,
    // A notification is a few kilobytes. Bun's default allows 128 MB.
    maxRequestBodySize: 1024 * 1024,
    fetch: createHandler({ store, token: config.webhookToken, startTurn }),
  });
  console.log(`listening on ${server.url}`);
}
