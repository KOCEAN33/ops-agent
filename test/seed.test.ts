import { afterAll, expect, test } from "bun:test";
import { seedSpend, spendFromMetrics } from "../src/seed";
import { Store } from "../src/store";

const now = new Date("2026-10-27T00:00:00Z");
// The month's start, in seconds.
const S = Date.parse("2026-10-01T00:00:00Z") / 1000;
const JOB = "ops-agent-test/ops-agent";

type Series = { metric: Record<string, string>; values: [number, string][] };
let series: Record<string, Series[]> = {};
let status = 200;
const queries: URLSearchParams[] = [];

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const q = new URL(req.url).searchParams;
    queries.push(q);
    if (status !== 200) return new Response("down", { status });
    const name = q.get("query")!.split("{")[0]!;
    return Response.json({ status: "success", data: { resultType: "matrix", result: series[name] ?? [] } });
  },
});
afterAll(() => server.stop());
const url = server.url.href.replace(/\/$/, "");

const s = (pod: string, values: [number, number][]): Series => ({
  metric: { job: JOB, pod, model: "example-model" },
  values: values.map(([t, v]) => [t, String(v)]),
});

test("the month's spend is each series' rise since the month began, reserved less refunded", async () => {
  series = {
    ops_agent_spend_reserved_usd_total: [
      // Up before the month began: 7 - 5.
      s("old", [[S - 60, 5], [S + 60, 6], [S + 120, 7]]),
      // Born in the month, its first scrape already holding spend: 0.8.
      s("new", [[S + 1000, 0.5], [S + 1030, 0.8]]),
      // A container restart resets it: 1 + 2, then 0.2 + 0.3.
      s("restarted", [[S + 10, 1], [S + 20, 3], [S + 30, 0.2], [S + 40, 0.5]]),
    ],
    ops_agent_spend_refunded_usd_total: [s("old", [[S - 60, 1], [S + 60, 1.5]])],
  };
  status = 200;

  expect(await spendFromMetrics({ url, job: JOB, now })).toBeCloseTo(6.3 - 0.5, 9);
  const asked = queries.slice(-2).map((q) => q.get("query")!);
  for (const q of asked) {
    expect(q).toContain(`job="${JOB}"`);
    // The range reaches back past the month's start, for the value there.
    const seconds = Number(q.match(/\[(\d+)s\]$/)![1]);
    expect(seconds).toBeGreaterThan(now.getTime() / 1000 - S);
  }
  expect(queries.at(-1)!.get("time")).toBe(String(now.getTime() / 1000));
});

test("a seed adds the metrics' spend to an empty month", async () => {
  series = { ops_agent_spend_reserved_usd_total: [s("a", [[S + 10, 2]])], ops_agent_spend_refunded_usd_total: [s("a", [[S + 10, 0.5]])] };
  status = 200;
  const store = new Store(":memory:");
  await seedSpend({ store, url, job: JOB, now });
  expect(store.monthSpend("2026-10")).toBeCloseTo(1.5, 9);
  expect(store.nextPost()).toBeNull();
});

test("a value below zero, as from a forged series, seeds zero", async () => {
  series = { ops_agent_spend_reserved_usd_total: [s("a", [[S + 10, 1]])], ops_agent_spend_refunded_usd_total: [s("a", [[S + 10, 4]])] };
  status = 200;
  const store = new Store(":memory:");
  await seedSpend({ store, url, job: JOB, now });
  expect(store.monthSpend("2026-10")).toBe(0);
});

test("a failed query seeds zero and tells the owner once", async () => {
  status = 503;
  const store = new Store(":memory:");
  await seedSpend({ store, url, job: JOB, now });
  await seedSpend({ store, url, job: JOB, now });
  expect(store.monthSpend("2026-10")).toBe(0);
  const post = store.nextPost();
  expect(post?.text).toContain("spend");
  store.postSent(post!.id);
  expect(store.nextPost()).toBeNull();
});
