import { expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelUsage } from "ai";
import { cost, runTurn, type AgentDeps } from "../src/agent";
import { Store } from "../src/store";

// USD per million tokens.
const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function usage(u: {
  input?: number;
  noCache?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}): LanguageModelUsage {
  return {
    inputTokens: u.input,
    inputTokenDetails: { noCacheTokens: u.noCache, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite },
    outputTokens: u.output,
    outputTokenDetails: { textTokens: u.output, reasoningTokens: undefined },
    totalTokens: undefined,
  };
}

test("cost prices each token class at its own rate", () => {
  // 1.0 * 3 + 0.2 * 0.3 + 0.1 * 3.75 + 0.5 * 15
  const u = usage({ input: 1_300_000, noCache: 1_000_000, cacheRead: 200_000, cacheWrite: 100_000, output: 500_000 });
  expect(cost(u, price)).toBeCloseTo(10.935, 9);
});

test("cost derives uncached input when the provider omits it", () => {
  // (1.0 - 0.2) * 3 + 0.2 * 0.3
  const u = usage({ input: 1_000_000, cacheRead: 200_000 });
  expect(cost(u, price)).toBeCloseTo(2.46, 9);
});

function model(reply: (n: number) => string, tokens = { noCache: 0, output: 0 }) {
  let n = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: reply(n++) }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: tokens.noCache, noCache: tokens.noCache, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: tokens.output, text: tokens.output, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

function deps(m: MockLanguageModelV4, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    model: m,
    price,
    turnCapUsd: 5,
    monthlyCapUsd: 50,
    store: new Store(":memory:"),
    instructions: async () => "",
    now: () => new Date("2026-10-26T03:00:00Z"),
    ...over,
  };
}

test("a later turn carries the session's earlier messages", async () => {
  const m = model((n) => `reply ${n}`);
  const d = deps(m);
  const { sessionId } = d.store.noteFiring({ alertname: "KubeJobFailed", namespace: "gallery-dl" }, ["a"]);

  await runTurn(d, sessionId, "first alert");
  await runTurn(d, sessionId, "second alert");

  const prompt = m.doGenerateCalls[1]!.prompt;
  expect(prompt.filter((p) => p.role !== "system")).toEqual([
    { role: "user", content: [{ type: "text", text: "first alert" }] },
    expect.objectContaining({ role: "assistant", content: [expect.objectContaining({ type: "text", text: "reply 0" })] }),
    { role: "user", content: [{ type: "text", text: "second alert" }] },
  ]);
});

test("once the month's spend reaches the cap, no model call is made", async () => {
  // One turn costs 1.0 * 3 + 0.5 * 15 = 10.5 USD, over a 10 USD monthly cap.
  const m = model(() => "ok", { noCache: 1_000_000, output: 500_000 });
  const d = deps(m, { monthlyCapUsd: 10, turnCapUsd: 20 });
  const { sessionId } = d.store.noteFiring({ alertname: "NodeDiskPressure", namespace: null }, ["a"]);

  expect(await runTurn(d, sessionId, "first")).toEqual({ text: "ok" });
  expect(await runTurn(d, sessionId, "second")).toEqual({ skipped: "monthly-cap" });
  expect(m.doGenerateCalls).toHaveLength(1);
});

test("the monthly cap resets when the month turns", async () => {
  const m = model(() => "ok", { noCache: 1_000_000, output: 500_000 });
  let now = new Date("2026-10-31T23:00:00Z");
  const d = deps(m, { monthlyCapUsd: 10, turnCapUsd: 20, now: () => now });
  const { sessionId } = d.store.noteFiring({ alertname: "NodeDiskPressure", namespace: null }, ["a"]);

  await runTurn(d, sessionId, "october");
  now = new Date("2026-11-01T01:00:00Z");
  expect(await runTurn(d, sessionId, "november")).toEqual({ text: "ok" });
});
