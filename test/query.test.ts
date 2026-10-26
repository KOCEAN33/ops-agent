import { afterAll, expect, test } from "bun:test";
import { lokiTools, promTools } from "../src/tools/query";
import { ToolError } from "../src/tools/contract";

const seen: URL[] = [];
let respond: () => Response = () => new Response(null, { status: 500 });
const server = Bun.serve({
  port: 0,
  fetch(req) {
    seen.push(new URL(req.url));
    return respond();
  },
});
afterAll(() => server.stop());

const now = new Date("2026-10-26T03:00:00Z");
const nowS = now.getTime() / 1000;
const url = server.url.href.replace(/\/$/, "");
const prom = promTools({ url, now: () => now });
const loki = lokiTools({ url, now: () => now });
const signal = new AbortController().signal;
const last = () => seen.at(-1)!;

const ok = (data: unknown) => () => Response.json({ status: "success", data });

test("promql runs an instant query at now and returns each series' labels and value", async () => {
  respond = ok({ resultType: "vector", result: [{ metric: { node: "node-1" }, value: [nowS, "0.93"] }] });
  const out = await prom.promql!.run({ query: "node_memory_usage" }, signal);

  expect(last().pathname).toBe("/api/v1/query");
  expect(last().searchParams.get("query")).toBe("node_memory_usage");
  expect(Number(last().searchParams.get("time"))).toBe(nowS);
  expect(out).toMatchObject({ result: [{ labels: { node: "node-1" }, value: "0.93" }] });
});

test("promql takes a time given as a duration before now", async () => {
  respond = ok({ resultType: "vector", result: [] });
  await prom.promql!.run({ query: "up", time: "2h" }, signal);
  expect(Number(last().searchParams.get("time"))).toBe(nowS - 7_200);
});

test("promql_range defaults to the last hour and reports the range it read", async () => {
  respond = ok({ resultType: "matrix", result: [{ metric: { pod: "web-0" }, values: [[nowS - 60, "1"], [nowS, "2"]] }] });
  const out = (await prom.promql_range!.run({ query: "rate(x[5m])" }, signal)) as Record<string, unknown>;

  const q = last().searchParams;
  expect(last().pathname).toBe("/api/v1/query_range");
  expect(Number(q.get("end"))).toBe(nowS);
  expect(Number(q.get("start"))).toBe(nowS - 3_600);
  expect(Number(q.get("step"))).toBeGreaterThan(0);
  expect(out).toMatchObject({ start: "2026-10-26T02:00:00.000Z", end: "2026-10-26T03:00:00.000Z" });
  expect(out.result).toEqual([{ labels: { pod: "web-0" }, values: [[nowS - 60, "1"], [nowS, "2"]] }]);
});

test("promql_range refuses a step that returns too many points, naming a step that fits, before any request", async () => {
  const before = seen.length;
  const err = await prom.promql_range!.run({ query: "up", start: "7d", step: "15s" }, signal).catch((e: ToolError) => e) as ToolError;
  expect(err).toBeInstanceOf(ToolError);
  expect(err.next).toMatch(/\d+s/);
  expect(seen).toHaveLength(before);
});

test("a query the store rejects fails with the store's message and a next step", async () => {
  respond = () => Response.json({ status: "error", errorType: "bad_data", error: 'parse error: unexpected "}"' }, { status: 400 });
  const err = await prom.promql!.run({ query: "up}" }, signal).catch((e: ToolError) => e) as ToolError;
  expect(err).toBeInstanceOf(ToolError);
  expect(err.message).toContain("parse error");
  expect(err.next).toBeString();
});

test("series past the cap are counted, not returned", async () => {
  const result = Array.from({ length: 80 }, (_, i) => ({ metric: { pod: `p-${i}` }, value: [nowS, "1"] }));
  respond = ok({ resultType: "vector", result });
  const out = (await prom.promql!.run({ query: "up" }, signal)) as { result: unknown[]; omittedSeries: number };
  expect(out.result.length + out.omittedSeries).toBe(80);
  expect(out.omittedSeries).toBeGreaterThan(0);
});

test("a time that is neither a timestamp nor a duration is a bad argument", () => {
  expect(prom.promql!.input.safeParse({ query: "up", time: "yesterday" }).success).toBe(false);
  expect(prom.promql!.input.safeParse({ query: "up", time: "2026-10-25T03:00:00Z" }).success).toBe(true);
});

test("logql reads the newest lines first over the last hour and cuts a long line", async () => {
  const ns = (s: number) => String(BigInt(s) * 1_000_000_000n);
  respond = ok({
    resultType: "streams",
    result: [{ stream: { namespace: "example-app", pod: "web-0" }, values: [[ns(nowS - 10), "x".repeat(5_000)], [ns(nowS - 20), "boot"]] }],
  });
  const out = (await loki.logql!.run({ query: '{namespace="example-app"}' }, signal)) as Record<string, unknown>;

  const q = last().searchParams;
  expect(last().pathname).toBe("/loki/api/v1/query_range");
  expect(q.get("direction")).toBe("backward");
  expect(q.get("start")).toBe(ns(nowS - 3_600));
  expect(q.get("end")).toBe(ns(nowS));
  expect(Number(q.get("limit"))).toBeGreaterThan(0);
  const [stream] = out.result as { labels: unknown; lines: [string, string][] }[];
  expect(stream!.labels).toEqual({ namespace: "example-app", pod: "web-0" });
  expect(stream!.lines[0]![0]).toBe("2026-10-26T02:59:50.000Z");
  expect(stream!.lines[0]![1].length).toBeLessThan(1_000);
  expect(stream!.lines[1]).toEqual(["2026-10-26T02:59:40.000Z", "boot"]);
});

test("a LogQL query Loki rejects fails with Loki's message", async () => {
  respond = () => new Response("parse error at line 1, col 2: syntax error", { status: 400 });
  const err = await loki.logql!.run({ query: "{" }, signal).catch((e: ToolError) => e) as ToolError;
  expect(err).toBeInstanceOf(ToolError);
  expect(err.message).toContain("syntax error");
});
