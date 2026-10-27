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
  // The port /metrics is served on, apart from the webhook. Off when unset, as
  // for a local run.
  metricsPort: number | null;
  // The scrape job of the agent's own metrics. With prometheusUrl, a start on
  // a new SQLite file seeds the month's spend from that job's counters.
  spendSeedJob: string | null;
  // Each read source left unset turns its tools off.
  kube: { url: string; serviceAccount: boolean } | null;
  prometheusUrl: string | null;
  lokiUrl: string | null;
  // Parent of the GitOps clones: owner/name is cloned at <gitopsDir>/<name>/current.
  gitopsDir: string | null;
  // owner/name of each GitOps repository, the first being the default issue
  // repository. Empty when neither reads nor issues are on.
  gitopsRepos: string[];
  // Off when unset, as for a local run, and posts wait in the store.
  discord: { token: string; channelId: string; ownerId: string } | null;
  // Off when unset, and hand-offs wait in the store.
  github: { appId: string; key: string } | null;
  // Hosts whose links survive in Discord posts and issues.
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

// Repository names, the part after the owner, name the clones and are what
// the model sees, so they must be unique.
function gitopsRepos(env: Env): string[] {
  const repos = (env.GITOPS_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  for (const r of repos) if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error(`GITOPS_REPOS entry ${r} is not owner/name`);
  const names = repos.map((r) => r.split("/")[1]!);
  // A name joins the clone's path.
  if (names.some((n) => n === "." || n === "..")) throw new Error("GITOPS_REPOS holds a name of . or ..");
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new Error(`GITOPS_REPOS names ${twice} twice`);
  return repos;
}

function gitopsDir(env: Env, repos: string[]): string | null {
  if (!env.GITOPS_DIR) return null;
  if (repos.length === 0) throw new Error("GITOPS_REPOS is not set");
  return env.GITOPS_DIR;
}

const GITHUB_VARS = ["GITHUB_APP_ID", "GITHUB_APP_KEY"];

// Any of them set means both, as for Discord, and a repository to file on.
function github(env: Env, repos: string[]): Config["github"] {
  if (!GITHUB_VARS.some((n) => env[n])) return null;
  const g = { appId: required(env, "GITHUB_APP_ID"), key: required(env, "GITHUB_APP_KEY") };
  if (repos.length === 0) throw new Error("GITOPS_REPOS is not set");
  return g;
}

// A local config.yaml's paths, in the chart values' shape, and the variable
// each sets. local holds what the chart fixes in a pod. A pod has no such file
// and gets every setting as a variable from the chart.
const YAML_VARS: [string, string][] = [
  ["model", "MODEL"],
  ["price.input", "PRICE_INPUT"],
  ["price.output", "PRICE_OUTPUT"],
  ["price.cacheRead", "PRICE_CACHE_READ"],
  ["price.cacheWrite", "PRICE_CACHE_WRITE"],
  ["turnCapUsd", "TURN_CAP_USD"],
  ["monthlyCapUsd", "MONTHLY_CAP_USD"],
  ["prometheusUrl", "PROMETHEUS_URL"],
  ["lokiUrl", "LOKI_URL"],
  ["linkAllowlist", "LINK_ALLOWLIST"],
  ["discord.channelId", "DISCORD_CHANNEL_ID"],
  ["discord.ownerId", "DISCORD_OWNER_ID"],
  ["github.appId", "GITHUB_APP_ID"],
  ["github.gitopsRepos", "GITOPS_REPOS"],
  ["local.dbPath", "DB_PATH"],
  ["local.port", "PORT"],
  ["local.kubeApiUrl", "KUBE_API_URL"],
  ["local.gitopsDir", "GITOPS_DIR"],
  ["local.instructionsDir", "INSTRUCTIONS_DIR"],
];

// YAML reads a bare 18-digit Discord ID as a float and rounds it.
const ID_PATHS = new Set(["discord.channelId", "discord.ownerId", "github.appId"]);

export function settingsFromYaml(text: string): Env {
  const root = Bun.YAML.parse(text) ?? {};
  const env: Env = {};
  for (const [path, name] of YAML_VARS) {
    const v = path.split(".").reduce<any>((o, k) => o?.[k], root);
    if (v === undefined || v === null || v === "") continue;
    if (ID_PATHS.has(path) && typeof v !== "string") throw new Error(`${path} in config.yaml must be quoted`);
    env[name] = Array.isArray(v) ? v.join(",") : String(v);
  }
  return env;
}

export function loadConfig(env: Env = process.env): Config {
  // @ai-sdk/anthropic reads the key itself. Checking it here fails the start
  // instead of the first alert.
  required(env, "ANTHROPIC_API_KEY");
  const model = required(env, "MODEL");
  const repos = gitopsRepos(env);
  return {
    model,
    price: price(env, model),
    turnCapUsd: usd(env, "TURN_CAP_USD"),
    monthlyCapUsd: usd(env, "MONTHLY_CAP_USD"),
    dbPath: required(env, "DB_PATH"),
    webhookToken: required(env, "WEBHOOK_TOKEN"),
    instructionsDir: env.INSTRUCTIONS_DIR || null,
    port: Number(env.PORT ?? 8080),
    metricsPort: env.METRICS_PORT ? Number(env.METRICS_PORT) : null,
    spendSeedJob: env.SPEND_SEED_JOB || null,
    kube: kube(env),
    prometheusUrl: url(env.PROMETHEUS_URL),
    lokiUrl: url(env.LOKI_URL),
    gitopsDir: gitopsDir(env, repos),
    gitopsRepos: repos,
    discord: discord(env),
    github: github(env, repos),
    linkHosts: new Set(
      (env.LINK_ALLOWLIST ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}
