import { anthropic } from "@ai-sdk/anthropic";
import { readInstructions, runTurn, type AgentDeps } from "./agent";
import { parseWebhook } from "./alert";
import { loadConfig } from "./config";
import { Store } from "./store";

export interface ServerDeps {
  store: Store;
  startTurn: (sessionId: number, text: string) => void;
}

export function createHandler(d: ServerDeps) {
  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (req.method !== "POST" || pathname !== "/alertmanager") {
      return new Response(null, { status: 404 });
    }
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

if (import.meta.main) {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const agent: AgentDeps = {
    model: anthropic(config.model),
    price: config.price,
    turnCapUsd: config.turnCapUsd,
    monthlyCapUsd: config.monthlyCapUsd,
    store,
    instructions: async () => (config.instructionsDir ? readInstructions(config.instructionsDir) : ""),
    now: () => new Date(),
  };

  // Turns on one session run one after another, so each sees the last one's
  // messages. Different sessions run in parallel.
  const queues = new Map<number, Promise<void>>();
  const startTurn = (sessionId: number, text: string) => {
    const next = (queues.get(sessionId) ?? Promise.resolve())
      .then(() => runTurn(agent, sessionId, text))
      .then(
        (r) => console.log(JSON.stringify({ msg: "turn", sessionId, ...r })),
        (e) => console.error(JSON.stringify({ msg: "turn failed", sessionId, error: String(e) })),
      );
    queues.set(sessionId, next);
  };

  const server = Bun.serve({ port: config.port, fetch: createHandler({ store, startTurn }) });
  console.log(`listening on ${server.url}`);
}
