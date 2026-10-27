import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError, type LanguageModelUsage } from "ai";
import { cost, MAX_OUTPUT_TOKENS, readInstructions, runTurn, type AgentDeps } from "../src/agent/turn";
import { Metrics } from "../src/metrics";
import { Store } from "../src/store";
import type { GroupKey } from "../src/alert";

// Queues a turn on the group's session, as a notification with a new set of
// firing alerts does.
let fingerprint = 0;
function notify(store: Store, key: GroupKey, text: string) {
  const { sessionId, turnId } = store.noteFiring(key, [String(fingerprint++)], text);
  return { id: turnId!, sessionId, text };
}

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
    tools: {},
    stepTimeoutMs: 60_000,
    compaction: { maskBytes: Infinity, summaryBytes: Infinity },
    metrics: new Metrics(),
    ...over,
  };
}

test("a later turn carries the session's earlier messages", async () => {
  const m = model((n) => `reply ${n}`);
  const d = deps(m);
  const key = { alertname: "KubeJobFailed", namespace: "example-app" };

  await runTurn(d, notify(d.store, key, "first alert"));
  await runTurn(d, notify(d.store, key, "second alert"));

  const prompt = m.doGenerateCalls[1]!.prompt;
  expect(prompt.filter((p) => p.role !== "system")).toEqual([
    { role: "user", content: [{ type: "text", text: "first alert" }] },
    expect.objectContaining({ role: "assistant", content: [expect.objectContaining({ type: "text", text: "reply 0" })] }),
    { role: "user", content: [{ type: "text", text: "second alert" }] },
  ]);
});

test("the system prompt carries the instructions for the session's alertname", async () => {
  const m = model(() => "ok");
  const d = deps(m, { instructions: async (alertname) => `runbook for ${alertname}` });

  await runTurn(d, notify(d.store, { alertname: "KubeJobFailed", namespace: "example-app" }, "alert"));

  const system = m.doGenerateCalls[0]!.prompt.find((p) => p.role === "system");
  expect(system?.content).toContain("runbook for KubeJobFailed");
});

test("once the month's spend reaches the cap, no model call is made", async () => {
  // One turn costs 1.0 * 3 + 0.5 * 15 = 10.5 USD, over a 10 USD monthly cap.
  const m = model(() => "ok", { noCache: 1_000_000, output: 500_000 });
  const d = deps(m, { monthlyCapUsd: 10, turnCapUsd: 20 });
  const key = { alertname: "NodeDiskPressure", namespace: null };

  expect(await runTurn(d, notify(d.store, key, "first"))).toEqual({ text: "ok" });
  expect(await runTurn(d, notify(d.store, key, "second"))).toEqual({ skipped: "monthly-cap" });
  expect(m.doGenerateCalls).toHaveLength(1);
});

// Output priced at 50 USD per million tokens makes the worst case of one call
// at least MAX_OUTPUT_TOKENS * 50 / 1e6 USD before input.
const pricey = { input: 2, output: 50, cacheRead: 0.1, cacheWrite: 2.5 };

test("turns on different sessions cannot together pass the monthly cap", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const m = new MockLanguageModelV4({
    doGenerate: async () => {
      await gate;
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const worstOutput = (MAX_OUTPUT_TOKENS * pricey.output) / 1e6;
  // Room for one call's worst case, not two.
  const d = deps(m, { price: pricey, monthlyCapUsd: worstOutput * 1.5, turnCapUsd: worstOutput * 10 });
  const a = notify(d.store, { alertname: "A", namespace: null }, "first");
  const b = notify(d.store, { alertname: "B", namespace: null }, "second");

  const turns = Promise.all([runTurn(d, a), runTurn(d, b)]);
  await Bun.sleep(0);
  release();
  const results = await turns;

  expect(m.doGenerateCalls).toHaveLength(1);
  expect(results).toContainEqual({ skipped: "monthly-cap" });
});

test("a call whose worst case exceeds the turn cap is never made", async () => {
  const m = model(() => "ok");
  const worstOutput = (MAX_OUTPUT_TOKENS * pricey.output) / 1e6;
  const d = deps(m, { price: pricey, turnCapUsd: worstOutput / 2, monthlyCapUsd: 100 });
  const key = { alertname: "A", namespace: null };

  expect(await runTurn(d, notify(d.store, key, "alert"))).toEqual({ skipped: "budget" });
  expect(m.doGenerateCalls).toHaveLength(0);
});

test("a model call is limited to MAX_OUTPUT_TOKENS", async () => {
  const m = model(() => "ok");
  const d = deps(m);
  const key = { alertname: "A", namespace: null };
  await runTurn(d, notify(d.store, key, "alert"));
  expect(m.doGenerateCalls[0]!.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
});

function failing(error: () => Error) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw error();
    },
  });
}

const apiError = (statusCode: number) =>
  new APICallError({ message: "x", url: "https://example.com", requestBodyValues: {}, statusCode, isRetryable: false });

test("a call the API answered with 200 keeps its reservation when its body fails to parse", async () => {
  const worstOutput = (MAX_OUTPUT_TOKENS * pricey.output) / 1e6;
  const store = new Store(":memory:");
  const caps = { price: pricey, monthlyCapUsd: worstOutput * 1.5, turnCapUsd: worstOutput * 10, store };
  const key = { alertname: "A", namespace: null };

  await expect(runTurn(deps(failing(() => apiError(200)), caps), notify(store, key, "first"))).rejects.toThrow();
  const next = model(() => "ok");
  expect(await runTurn(deps(next, caps), notify(store, key, "second"))).toEqual({ skipped: "monthly-cap" });
  expect(next.doGenerateCalls).toHaveLength(0);
});

test("a call the API refused with an error status is not charged", async () => {
  const worstOutput = (MAX_OUTPUT_TOKENS * pricey.output) / 1e6;
  const store = new Store(":memory:");
  const caps = { price: pricey, monthlyCapUsd: worstOutput * 1.5, turnCapUsd: worstOutput * 10, store };
  const key = { alertname: "A", namespace: null };

  await expect(runTurn(deps(failing(() => apiError(400)), caps), notify(store, key, "first"))).rejects.toThrow();
  expect(await runTurn(deps(model(() => "ok"), caps), notify(store, key, "second"))).toEqual({ text: "ok" });
});

test("a reservation refused on a retry is reported, not thrown", async () => {
  const store = new Store(":memory:");
  const d = deps(
    failing(() => {
      // Another session spends the rest of the month while this call fails.
      store.addSpend("2026-10", 1_000);
      return new APICallError({ message: "overloaded", url: "https://example.com", requestBodyValues: {}, statusCode: 529, isRetryable: true });
    }),
    { store },
  );
  const key = { alertname: "A", namespace: null };
  expect(await runTurn(d, notify(store, key, "alert"))).toEqual({ skipped: "monthly-cap" });
}, 15_000);

test("the monthly cap resets when the month turns", async () => {
  const m = model(() => "ok", { noCache: 1_000_000, output: 500_000 });
  let now = new Date("2026-10-31T23:00:00Z");
  const d = deps(m, { monthlyCapUsd: 10, turnCapUsd: 20, now: () => now });
  const key = { alertname: "NodeDiskPressure", namespace: null };

  await runTurn(d, notify(d.store, key, "october"));
  now = new Date("2026-11-01T01:00:00Z");
  expect(await runTurn(d, notify(d.store, key, "november"))).toEqual({ text: "ok" });
});

test("attempts of one turn share its turn cap, across a restart", async () => {
  const worstOutput = (MAX_OUTPUT_TOKENS * pricey.output) / 1e6;
  const file = join(mkdtempSync(join(tmpdir(), "ops-agent-")), "db.sqlite");
  // Room for one call's worst case, not two.
  const caps = { price: pricey, turnCapUsd: worstOutput * 1.5, monthlyCapUsd: 100 };
  const before = new Store(file);
  const turn = notify(before, { alertname: "A", namespace: null }, "alert");

  // A failure that is not an API error status keeps the call's reservation.
  await expect(runTurn(deps(failing(() => new Error("socket closed")), { ...caps, store: before }), turn)).rejects.toThrow();

  const next = model(() => "ok");
  expect(await runTurn(deps(next, { ...caps, store: new Store(file) }), turn)).toEqual({ skipped: "budget" });
  expect(next.doGenerateCalls).toHaveLength(0);
});

test("a model call that stalls fails the attempt instead of holding a turn slot", async () => {
  const m = new MockLanguageModelV4({
    doGenerate: ({ abortSignal }) =>
      new Promise((_, reject) => abortSignal?.addEventListener("abort", () => reject(abortSignal.reason))),
  });
  const d = deps(m, { stepTimeoutMs: 50 });
  await expect(runTurn(d, notify(d.store, { alertname: "A", namespace: null }, "alert"))).rejects.toThrow();
  expect(d.store.pending()).toHaveLength(1);
});

test("a finished turn queues its answer for the owner", async () => {
  const d = deps(model(() => "found the cause"));
  const turn = notify(d.store, { alertname: "A", namespace: null }, "alert");
  await runTurn(d, turn);
  expect(d.store.nextPost()).toMatchObject({ sessionId: turn.sessionId, text: "found the cause" });
});

test("a turn ended by its spend cap still tells the owner", async () => {
  const m = model(() => "ok");
  const worstOutput = (MAX_OUTPUT_TOKENS * pricey.output) / 1e6;
  const d = deps(m, { price: pricey, turnCapUsd: worstOutput / 2 });
  const turn = notify(d.store, { alertname: "A", namespace: null }, "alert");
  await runTurn(d, turn);
  expect(d.store.nextPost()?.text).toContain("spend");
});

test("instructions are every markdown file but the README and the other alerts' runbooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-agent-instructions-"));
  mkdirSync(join(dir, "core"));
  mkdirSync(join(dir, "runbooks"));
  writeFileSync(join(dir, "README.md"), "readme");
  writeFileSync(join(dir, "core", "a.md"), "core");
  writeFileSync(join(dir, "runbooks", "KubeJobFailed.md"), "job runbook");
  writeFileSync(join(dir, "runbooks", "NodeDown.md"), "node runbook");
  expect(await readInstructions(dir, "KubeJobFailed")).toBe("core\n\njob runbook");
  expect(await readInstructions(dir, "NoRunbook")).toBe("core");
  // An alertname is stranger text, so it never reaches a file by path.
  expect(await readInstructions(dir, "../README")).toBe("core");
  expect(await readInstructions(dir, "../core/a")).toBe("core");
  // git-sync creates its link only after the first sync.
  expect(await readInstructions(join(dir, "current"), "KubeJobFailed")).toBeNull();
});
