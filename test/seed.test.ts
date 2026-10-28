import { afterAll, expect, test } from "bun:test";
import { seedSpend, spendFromMetrics } from "../src/seed";
import { Store } from "../src/store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = new Date("2026-10-27T00:00:00Z");
// The month's start, in seconds.
const S = Date.parse("2026-10-01T00:00:00Z") / 1000;
const JOB = "ops-agent-test/ops-agent";

type Series = { metric: Record<string, string>; values: [number, string][] };
let series: Record<string, Series[]> = {};
let status = 200;
let warnings: string[] | undefined;
const queries: URLSearchParams[] = [];

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const q = new URL(req.url).searchParams;
    queries.push(q);
    if (status !== 200) return new Response("down", { status });
    const name = q.get("query")!.split("{")[0]!;
    return Response.json({ status: "success", data: { resultType: "matrix", result: series[name] ?? [] }, ...(warnings ? { warnings } : {}) });
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
  // Thanos Query answers with what it has when a store is down, unless told not to.
  expect(queries.at(-1)!.get("partial_response")).toBe("false");
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
  expect(post?.text).toContain("비용");
  store.postSent(post!.id);
  expect(store.nextPost()).toBeNull();
});

test("a refunded series counts only against its reserved twin, and never below zero for that twin", async () => {
  series = {
    ops_agent_spend_reserved_usd_total: [s("a", [[S + 10, 2]]), s("b", [[S + 10, 1]])],
    ops_agent_spend_refunded_usd_total: [
      // Its twin rose 1, so it takes b down to zero, not below.
      s("b", [[S + 10, 5]]),
      // No reserved twin: a forged series, which counts for nothing.
      s("forged", [[S + 10, 1000]]),
    ],
  };
  status = 200;
  warnings = undefined;
  expect(await spendFromMetrics({ url, job: JOB, now })).toBeCloseTo(2, 9);
});

test("a series holding a value no counter can hold is left out", async () => {
  series = {
    ops_agent_spend_reserved_usd_total: [s("a", [[S + 10, 2]]), { metric: { job: JOB, pod: "nan" }, values: [[S + 10, "NaN"]] }],
    ops_agent_spend_refunded_usd_total: [{ metric: { job: JOB, pod: "a", model: "example-model" }, values: [[S + 10, "-3"]] }],
  };
  status = 200;
  warnings = undefined;
  expect(await spendFromMetrics({ url, job: JOB, now })).toBeCloseTo(2, 9);
});

test("a partial answer, as when a store behind Thanos is down, fails the seed", async () => {
  series = { ops_agent_spend_reserved_usd_total: [s("a", [[S + 10, 2]])] };
  status = 200;
  warnings = ["receive series from store: unavailable"];
  const store = new Store(":memory:");
  await seedSpend({ store, url, job: JOB, now });
  warnings = undefined;
  expect(store.monthSpend("2026-10")).toBe(0);
  expect(store.nextPost()?.text).toContain("비용");
});

test("a new file waits for its seed across restarts until a seed or a failed read ends the wait", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ops-agent-seed-")), "agent.sqlite");
  expect(new Store(path).seedPending()).toBe(true);
  // A start cut before the seed leaves the wait in place.
  expect(new Store(path).seedPending()).toBe(true);

  series = { ops_agent_spend_reserved_usd_total: [s("a", [[S + 10, 2]])] };
  status = 200;
  await seedSpend({ store: new Store(path), url, job: JOB, now });
  const after = new Store(path);
  expect(after.seedPending()).toBe(false);
  expect(after.monthSpend("2026-10")).toBeCloseTo(2, 9);

  const failed = join(mkdtempSync(join(tmpdir(), "ops-agent-seed-")), "agent.sqlite");
  status = 503;
  await seedSpend({ store: new Store(failed), url, job: JOB, now });
  expect(new Store(failed).seedPending()).toBe(false);
});
