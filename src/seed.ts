import type { Store } from "./store";

// A new SQLite file that no restore filled would restart the month's spend at
// zero. The agent's spend counters outlive the file in the metrics store, so a
// start on such a file reads the month's spend back from them (docs/design.md,
// Spend seed after a lost file).

const RESERVED = "ops_agent_spend_reserved_usd_total";
const REFUNDED = "ops_agent_spend_refunded_usd_total";

// Reaches back past the month's start for each series' value there.
const LOOKBACK_S = 300;
const TIMEOUT_MS = 20_000;

const SEED_FAILED =
  "The SQLite file was new and the month's model spend could not be read from the metrics store, so the monthly cap counts from zero this month.";

export interface SeedDeps {
  // The PromQL endpoint, without a trailing slash.
  url: string;
  // The agent's own scrape job, so another job's series never count.
  job: string;
  now: Date;
}

type Matrix = { metric: Record<string, string>; values: [number, string][] }[];

async function samples(d: SeedDeps, metric: string, since: number): Promise<Matrix> {
  const range = Math.ceil(d.now.getTime() / 1000 - since) + LOOKBACK_S;
  const query = new URLSearchParams({ query: `${metric}{job="${d.job}"}[${range}s]`, time: String(d.now.getTime() / 1000) });
  const res = await fetch(`${d.url}/api/v1/query?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the metrics store answered ${res.status}`);
  const body = (await res.json()) as { status: string; data?: { resultType: string; result: Matrix } };
  if (body.status !== "success" || body.data?.resultType !== "matrix") throw new Error("the metrics store sent no matrix");
  return body.data.result;
}

// The sum over series of each one's rise since the month began. A series up
// before then starts from its last value there, and one born in the month from
// zero, so the spend its first scrape already holds counts. A drop is a
// counter reset, after which the new value is all new.
function rise(m: Matrix, since: number): number {
  let total = 0;
  for (const { values } of m) {
    let prev = 0;
    for (const [t, raw] of values) {
      const v = Number(raw);
      if (t <= since) prev = v;
      else {
        total += v >= prev ? v - prev : v;
        prev = v;
      }
    }
  }
  return total;
}

// What the store charged this month across every pod: reserved less refunded.
export async function spendFromMetrics(d: SeedDeps): Promise<number> {
  const since = Date.UTC(d.now.getUTCFullYear(), d.now.getUTCMonth(), 1) / 1000;
  const [reserved, refunded] = await Promise.all([samples(d, RESERVED, since), samples(d, REFUNDED, since)]);
  return rise(reserved, since) - rise(refunded, since);
}

// A forged series can only raise the seed, which stops model calls early and
// fails safe. A failed read seeds zero, and the owner hears of it once.
export async function seedSpend(d: SeedDeps & { store: Store }): Promise<void> {
  const month = d.now.toISOString().slice(0, 7);
  try {
    const usd = Math.max(0, await spendFromMetrics(d));
    d.store.addSpend(month, usd);
    console.log(JSON.stringify({ msg: "spend seeded", month, usd }));
  } catch (e) {
    console.error(JSON.stringify({ msg: "spend seed failed", month, error: String(e) }));
    d.store.noticeOnce(`spend-seed-failed ${month}`, SEED_FAILED);
  }
}
