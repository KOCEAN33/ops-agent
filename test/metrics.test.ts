import { expect, test } from "bun:test";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runTurn, type AgentDeps } from "../src/agent/turn";
import { Metrics } from "../src/metrics";
import { metricsHandler } from "../src/server";
import { Store } from "../src/store";
import { readTool } from "../src/tools/contract";

// USD per million tokens.
const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const usage = (noCache: number, output: number) => ({
  inputTokens: { total: noCache, noCache, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

// Calls the probe tool once, then answers. Each call reports the given usage.
function model(u = usage(0, 0)) {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "example-model",
    doGenerate: async () =>
      n++ === 0
        ? {
            content: [{ type: "tool-call", toolCallId: "call-1", toolName: "probe", input: JSON.stringify({ name: "web" }) }],
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: u,
            warnings: [],
          }
        : { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "end_turn" }, usage: u, warnings: [] },
  });
}

function deps(m: MockLanguageModelV4, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    model: m,
    price,
    turnCapUsd: 20,
    monthlyCapUsd: 50,
    store: new Store(":memory:"),
    instructions: async () => "",
    now: () => new Date("2026-10-26T03:00:00Z"),
    tools: { probe: readTool({ description: "Reads a thing.", input: z.object({ name: z.string() }), run: async () => "ok" }) },
    stepTimeoutMs: 60_000,
    compaction: { maskBytes: Infinity, summaryBytes: Infinity },
    metrics: new Metrics(),
    ...over,
  };
}

let fingerprint = 0;
function turn(d: AgentDeps) {
  const { sessionId, turnId } = d.store.noteFiring({ alertname: "KubeJobFailed", namespace: "example-app" }, [String(fingerprint++)], "alert");
  return { id: turnId!, sessionId, text: "alert" };
}

// The value of one sample in the text format, or undefined when absent.
function sample(text: string, series: string): number | undefined {
  const line = text.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

test("a done turn adds its reported cost to the spend counter and observes its spend, tokens and tool calls", async () => {
  // Two calls, each 1,000,000 input tokens at 3 USD and 100,000 output tokens
  // at 15 USD: 4.5 USD a call, 9 USD for the turn.
  const d = deps(model(usage(1_000_000, 100_000)));
  await runTurn(d, turn(d));
  const t = d.metrics.text();

  expect(sample(t, 'ops_agent_spend_usd_total{model="example-model"}')).toBeCloseTo(9, 9);
  expect(sample(t, 'ops_agent_turns_total{end="done"}')).toBe(1);
  expect(sample(t, 'ops_agent_tool_calls_total{tool="probe"}')).toBe(1);
  expect(sample(t, 'ops_agent_turn_spend_usd_count{model="example-model"}')).toBe(1);
  expect(sample(t, 'ops_agent_turn_spend_usd_sum{model="example-model"}')).toBeCloseTo(9, 9);
  expect(sample(t, 'ops_agent_turn_spend_usd_bucket{model="example-model",le="5"}')).toBe(0);
  expect(sample(t, 'ops_agent_turn_spend_usd_bucket{model="example-model",le="+Inf"}')).toBe(1);
  expect(sample(t, 'ops_agent_turn_input_tokens_sum{model="example-model"}')).toBe(2_000_000);
  expect(sample(t, 'ops_agent_turn_output_tokens_sum{model="example-model"}')).toBe(200_000);
  expect(sample(t, 'ops_agent_turn_duration_seconds_count{model="example-model"}')).toBe(1);
});

test("a turn the monthly cap defers counts as monthly-cap and observes no turn spend", async () => {
  const d = deps(model());
  d.store.reserve("2026-10", turn(d).id, 50, 100, 100);
  await runTurn(d, turn(d));
  const t = d.metrics.text();

  expect(sample(t, 'ops_agent_turns_total{end="monthly-cap"}')).toBe(1);
  expect(sample(t, 'ops_agent_turns_total{end="done"}')).toBeUndefined();
  expect(sample(t, 'ops_agent_turn_spend_usd_count{model="example-model"}')).toBeUndefined();
});

test("an attempt that throws counts as failed, and a call that may have run stays in the spend counter", async () => {
  const m = new MockLanguageModelV4({
    modelId: "example-model",
    // No status and not retryable: the call may have run, and the SDK does
    // not try it again.
    doGenerate: async () => {
      throw new APICallError({ message: "socket hang up", url: "https://api.example.com", requestBodyValues: {}, isRetryable: false });
    },
  });
  const d = deps(m);
  await expect(runTurn(d, turn(d))).rejects.toThrow();
  const t = d.metrics.text();

  expect(sample(t, 'ops_agent_turns_total{end="failed"}')).toBe(1);
  // The store keeps each failed call's worst case, and the counter matches it.
  expect(sample(t, 'ops_agent_spend_usd_total{model="example-model"}')).toBeCloseTo(d.store.monthSpend("2026-10"), 9);
  expect(d.store.monthSpend("2026-10")).toBeGreaterThan(0);
});

test("the metrics handler serves the text format at /metrics and nothing else", async () => {
  const metrics = new Metrics();
  metrics.turns.inc({ end: "done" });
  const handle = metricsHandler(metrics);

  const res = await handle(new Request("http://agent.example.com/metrics"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain; version=0.0.4");
  expect(sample(await res.text(), 'ops_agent_turns_total{end="done"}')).toBe(1);

  expect((await handle(new Request("http://agent.example.com/alertmanager", { method: "POST" }))).status).toBe(404);
});

test("a histogram bucket counts a value equal to its bound, as Prometheus's le does", () => {
  const m = new Metrics();
  m.turnSpend.observe({ model: "example-model" }, 0.05);
  const t = m.text();
  expect(sample(t, 'ops_agent_turn_spend_usd_bucket{model="example-model",le="0.02"}')).toBe(0);
  expect(sample(t, 'ops_agent_turn_spend_usd_bucket{model="example-model",le="0.05"}')).toBe(1);
});
