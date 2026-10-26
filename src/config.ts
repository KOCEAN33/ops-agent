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

export function loadConfig(env: Env = process.env): Config {
  // @ai-sdk/anthropic reads the key itself. Checking it here fails the start
  // instead of the first alert.
  required(env, "ANTHROPIC_API_KEY");
  return {
    model: required(env, "MODEL"),
    price: {
      input: usd(env, "PRICE_INPUT"),
      output: usd(env, "PRICE_OUTPUT"),
      cacheRead: usd(env, "PRICE_CACHE_READ"),
      cacheWrite: usd(env, "PRICE_CACHE_WRITE"),
    },
    turnCapUsd: usd(env, "TURN_CAP_USD"),
    monthlyCapUsd: usd(env, "MONTHLY_CAP_USD"),
    dbPath: required(env, "DB_PATH"),
    instructionsDir: env.INSTRUCTIONS_DIR || null,
    port: Number(env.PORT ?? 8080),
  };
}
