import { anthropic } from "@ai-sdk/anthropic";
import { timingSafeEqual } from "node:crypto";
import { readInstructions, runTurn, type AgentDeps } from "./agent/turn";
import { parseWebhook } from "./alert";
import { connect, onMessage, Outbox } from "./owner/discord";
import { loadConfig, settingsFromYaml, type Config } from "./config";
import { gitopsTools } from "./tools/gitops";
import { githubApi, IssueQueue, issueRepositoryTool, issueSummaryTool } from "./owner/issues";
import { kubeTools } from "./tools/kube";
import { lokiTools, promTools } from "./tools/query";
import { TurnQueue } from "./queue";
import { Store } from "./store";
import type { ReadTool } from "./tools/contract";

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
// Each step resends the history, and the spend middleware reserves a call at
// one input token per prompt byte. At Claude Sonnet 5.5's price, 100 KB of
// history reserves about 0.26 USD of input on every step.
const COMPACTION = { maskBytes: 50_000, summaryBytes: 100_000 };
// Every producer of a post, a restart included, is covered by one poll.
const OUTBOX_POLL_MS = 2_000;

const INSTRUCTIONS_MISSING =
  "The operating instructions clone is missing, so turns run on the base instructions alone. Check the instructions git-sync sidecar's log.";

// GitHub allows 5,000 requests an hour to an installation, and a failing write
// is retried on each poll.
const ISSUE_POLL_MS = 10_000;

const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

async function readTools(c: Config, now: () => Date): Promise<Record<string, ReadTool>> {
  const k = c.kube;
  // Config fails the start when reads or issues are on without a repository.
  // The record tool is on whenever repositories are listed, so a hand-off
  // queued while issues are off keeps the model's choice.
  const names = c.gitopsRepos.map((r) => r.split("/")[1]!) as [string, ...string[]];
  return {
    ...(k &&
      kubeTools({
        url: k.url,
        token: async () => (k.serviceAccount ? (await Bun.file(`${SERVICE_ACCOUNT}/token`).text()).trim() : null),
        ca: k.serviceAccount ? await Bun.file(`${SERVICE_ACCOUNT}/ca.crt`).text() : undefined,
      })),
    ...(c.prometheusUrl && promTools({ url: c.prometheusUrl, now })),
    ...(c.lokiUrl && lokiTools({ url: c.lokiUrl, now })),
    ...(c.gitopsDir && gitopsTools(c.gitopsDir, names)),
    ...(names.length > 0 && issueRepositoryTool(names)),
    ...issueSummaryTool(),
  };
}

if (import.meta.main) {
  // A variable set in the environment, such as on the command line, wins over
  // the local file.
  const local = Bun.file("config.yaml");
  const config = loadConfig({ ...((await local.exists()) ? settingsFromYaml(await local.text()) : {}), ...process.env });
  const store = new Store(config.dbPath);
  const now = () => new Date();
  const agent: AgentDeps = {
    model: anthropic(config.model),
    price: config.price,
    turnCapUsd: config.turnCapUsd,
    monthlyCapUsd: config.monthlyCapUsd,
    store,
    instructions: async () => {
      if (!config.instructionsDir) return "";
      const text = await readInstructions(config.instructionsDir);
      if (text !== null) return text;
      // A missing clone would otherwise fail every turn. The turn runs on the
      // base instructions, and the owner hears of it once a day.
      console.error(JSON.stringify({ msg: "instructions clone missing", dir: config.instructionsDir }));
      store.noticeOnce(`instructions-missing ${now().toISOString().slice(0, 10)}`, INSTRUCTIONS_MISSING);
      return "";
    },
    now,
    tools: await readTools(config, now),
    stepTimeoutMs: STEP_TIMEOUT_MS,
    compaction: COMPACTION,
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

  const d = config.discord;
  if (d) {
    const api = connect(d.token, (m) => onMessage({ store, ownerId: d.ownerId, kick: () => queue.kick() }, m));
    const outbox = new Outbox({ store, api, channelId: d.channelId, linkHosts: config.linkHosts });
    setInterval(() => void outbox.flush(), OUTBOX_POLL_MS);
  } else {
    console.log(JSON.stringify({ msg: "discord off: posts wait in the store" }));
  }

  const g = config.github;
  if (g) {
    // A key that does not parse stops the start here.
    const api = githubApi({ apiUrl: "https://api.github.com", ...g, now });
    const issues = new IssueQueue({ store, api, linkHosts: config.linkHosts, repos: config.gitopsRepos });
    setInterval(() => void issues.flush(), ISSUE_POLL_MS);
  } else {
    console.log(JSON.stringify({ msg: "issues off: hand-offs wait in the store" }));
  }

  const server = Bun.serve({
    port: config.port,
    // A notification is a few kilobytes. Bun's default allows 128 MB.
    maxRequestBodySize: 1024 * 1024,
    fetch: createHandler({ store, token: config.webhookToken, kick: () => queue.kick() }),
  });
  console.log(`listening on ${server.url}`);
}
