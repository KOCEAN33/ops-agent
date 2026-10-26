// USD per million tokens, for the configured model.
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Config {
  model: string;
  price: Price;
  turnCapUsd: number;
  monthlyCapUsd: number;
  dbPath: string;
  webhookToken: string;
  instructionsDir: string | null;
  port: number;
  // Each read source left unset turns its tools off.
  kube: { url: string; serviceAccount: boolean } | null;
  prometheusUrl: string | null;
  lokiUrl: string | null;
  gitopsDir: string | null;
  // Off when unset, as for a local run, and posts wait in the store.
  discord: { token: string; channelId: string; ownerId: string } | null;
  // Hosts whose links survive in Discord posts.
  linkHosts: Set<string>;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function usd(env: Env, name: string): number {
  const n = Number(required(env, name));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} is not a non-negative number`);
  return n;
}

// Anthropic list prices with 5-minute cache writes, from
// https://platform.claude.com/docs/en/about-claude/pricing. Edit a row when
// Anthropic changes a price. Claude Haiku 5.5 is left out: its price rises for
// prompts over 100k tokens, which one flat price cannot hold.
const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

const PRICE_VARS = ["PRICE_INPUT", "PRICE_OUTPUT", "PRICE_CACHE_READ", "PRICE_CACHE_WRITE"];

// A model without a known price would leave the spend caps blind, so it stops
// the start instead.
function price(env: Env, model: string): Price {
  // Any PRICE_* set means all four: usd() throws on a missing one, so a partial
  // set never mixes with the table.
  if (PRICE_VARS.some((n) => env[n])) {
    return {
      input: usd(env, "PRICE_INPUT"),
      output: usd(env, "PRICE_OUTPUT"),
      cacheRead: usd(env, "PRICE_CACHE_READ"),
      cacheWrite: usd(env, "PRICE_CACHE_WRITE"),
    };
  }
  const listed = PRICES[model];
  if (!listed) throw new Error(`no built-in price for ${model}: set ${PRICE_VARS.join(", ")}`);
  return listed;
}

const url = (v: string | undefined) => (v ? v.replace(/\/+$/, "") : null);

// KUBE_API_URL points at an API server that needs no token, such as
// `kubectl proxy` on a workstation. In a pod, Kubernetes sets the service
// address, and requests carry the pod's ServiceAccount token.
function kube(env: Env): Config["kube"] {
  if (env.KUBE_API_URL) return { url: url(env.KUBE_API_URL)!, serviceAccount: false };
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) return null;
  return { url: `https://${host.includes(":") ? `[${host}]` : host}:${env.KUBERNETES_SERVICE_PORT ?? 443}`, serviceAccount: true };
}

const DISCORD_VARS = ["DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID", "DISCORD_OWNER_ID"];

// Any DISCORD_* set means all three, so a half-configured bot fails the start.
function discord(env: Env): Config["discord"] {
  if (!DISCORD_VARS.some((n) => env[n])) return null;
  return {
    token: required(env, "DISCORD_BOT_TOKEN"),
    channelId: required(env, "DISCORD_CHANNEL_ID"),
    ownerId: required(env, "DISCORD_OWNER_ID"),
  };
}

export function loadConfig(env: Env = process.env): Config {
  // @ai-sdk/anthropic reads the key itself. Checking it here fails the start
  // instead of the first alert.
  required(env, "ANTHROPIC_API_KEY");
  const model = required(env, "MODEL");
  return {
    model,
    price: price(env, model),
    turnCapUsd: usd(env, "TURN_CAP_USD"),
    monthlyCapUsd: usd(env, "MONTHLY_CAP_USD"),
    dbPath: required(env, "DB_PATH"),
    webhookToken: required(env, "WEBHOOK_TOKEN"),
    instructionsDir: env.INSTRUCTIONS_DIR || null,
    port: Number(env.PORT ?? 8080),
    kube: kube(env),
    prometheusUrl: url(env.PROMETHEUS_URL),
    lokiUrl: url(env.LOKI_URL),
    gitopsDir: env.GITOPS_DIR || null,
    discord: discord(env),
    linkHosts: new Set(
      (env.LINK_ALLOWLIST ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}
