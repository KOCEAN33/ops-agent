import type { Store } from "./store";

// A new SQLite file that no restore filled would restart the month's spend at
// zero. The agent's spend counters outlive the file in the metrics store, so a
// start on such a file reads the month's spend back from them (docs/design/
// chosen.md, Spend seed after a lost file).

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
  // Thanos Query answers with what it has when a store behind it is down,
  // which would seed a few hours of the month, unless told not to.
  const query = new URLSearchParams({
    query: `${metric}{job="${d.job}"}[${range}s]`,
    time: String(d.now.getTime() / 1000),
    partial_response: "false",
  });
  const res = await fetch(`${d.url}/api/v1/query?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the metrics store answered ${res.status}`);
  const body = (await res.json()) as { status: string; data?: { resultType: string; result: Matrix }; warnings?: string[] };
  if (body.status !== "success" || body.data?.resultType !== "matrix") throw new Error("the metrics store sent no matrix");
  if (body.warnings?.length) throw new Error(`the metrics store answered in part: ${body.warnings[0]}`);
  return body.data.result;
}

// A series' rise since the month began, or null when a sample is no value a
// counter can hold. A series up before then starts from its last value there,
// and one born in the month from zero, so the spend its first scrape already
// holds counts. A drop is a counter reset, after which the new value is all new.
function rise(values: [number, string][], since: number): number | null {
  let total = 0;
  let prev = 0;
  for (const [t, raw] of values) {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return null;
    if (t <= since) prev = v;
    else {
      total += v >= prev ? v - prev : v;
      prev = v;
    }
  }
  return total;
}

// A series' identity apart from its metric name, which pairs the two counters
// of one pod and model.
const twin = (metric: Record<string, string>) =>
  JSON.stringify(Object.entries(metric).filter(([k]) => k !== "__name__").sort(([a], [b]) => a.localeCompare(b)));

// What the store charged this month across every pod: each reserved series'
// rise less its refunded twin's, kept between zero and the reserved rise. A
// series written into the metrics store can then only raise the seed: a
// refunded series with no twin counts for nothing, and a series no counter
// could hold is left out.
export async function spendFromMetrics(d: SeedDeps): Promise<number> {
  const since = Date.UTC(d.now.getUTCFullYear(), d.now.getUTCMonth(), 1) / 1000;
  const [reserved, refunded] = await Promise.all([samples(d, RESERVED, since), samples(d, REFUNDED, since)]);
  const refunds = new Map(refunded.map((r) => [twin(r.metric), rise(r.values, since)]));
  let total = 0;
  for (const r of reserved) {
    const charged = rise(r.values, since);
    if (charged === null) continue;
    const back = refunds.get(twin(r.metric)) ?? 0;
    total += Math.max(0, charged - (back ?? 0));
  }
  return total;
}

// A raised seed stops model calls early, which fails safe. A failed read
// seeds zero, and the owner hears of it once. Either ends the file's wait.
export async function seedSpend(d: SeedDeps & { store: Store }): Promise<void> {
  const month = d.now.toISOString().slice(0, 7);
  let usd: number;
  try {
    usd = await spendFromMetrics(d);
  } catch (e) {
    console.error(JSON.stringify({ msg: "spend seed failed", month, error: String(e) }));
    d.store.seedFailed(`spend-seed-failed ${month}`, SEED_FAILED);
    return;
  }
  d.store.seeded(month, usd);
  console.log(JSON.stringify({ msg: "spend seeded", month, usd }));
}
