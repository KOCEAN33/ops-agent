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
  };
}
