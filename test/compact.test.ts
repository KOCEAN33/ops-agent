import { expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { z } from "zod";
import { runTurn, type AgentDeps } from "../src/agent/turn";
import { Store } from "../src/store";
import { readTool } from "../src/tools/contract";

const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const zero = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

// Each turn's one tool call returns this many characters.
const OUTPUT_CHARS = 5_000;

// A model that calls the probe once per turn and then answers. A call without
// tools is a summary request, answered with "summary <n>".
function scripted(summaryUsage = zero, summaryEnd: "stop" | "length" = "stop") {
  let summaries = 0;
  const m = new MockLanguageModelV4({
    doGenerate: async (o: LanguageModelV4CallOptions) => {
      if (!o.tools?.length) {
        return { content: [{ type: "text", text: `summary ${summaries++}` }], finishReason: { unified: summaryEnd, raw: summaryEnd }, usage: summaryUsage, warnings: [] };
      }
      const last = o.prompt.at(-1)!;
      if (last.role === "tool") {
        return { content: [{ type: "text", text: "answered" }], finishReason: { unified: "stop", raw: "end_turn" }, usage: zero, warnings: [] };
      }
      return {
        content: [{ type: "tool-call", toolCallId: `call-${m.doGenerateCalls.length}`, toolName: "probe", input: JSON.stringify({ name: "x" }) }],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: zero,
        warnings: [],
      };
    },
  });
  return m;
}

const probe = readTool({
  description: "Reads a thing.",
  input: z.object({ name: z.string() }),
  run: async () => "o".repeat(OUTPUT_CHARS),
});

function deps(m: MockLanguageModelV4, store: Store, compaction: AgentDeps["compaction"]): AgentDeps {
  return {
    model: m,
    price,
    turnCapUsd: 5,
    monthlyCapUsd: 50,
    store,
    instructions: async () => "",
    now: () => new Date("2026-10-26T03:00:00Z"),
    tools: { probe },
    stepTimeoutMs: 60_000,
    compaction,
  };
}

const off = { maskBytes: Infinity, summaryBytes: Infinity };

let fingerprint = 0;
async function alert(d: AgentDeps, text: string) {
  const { sessionId, turnId } = d.store.noteFiring({ alertname: "KubePodCrashLooping", namespace: "example-app" }, [String(fingerprint++)], text);
  await runTurn(d, { id: turnId!, sessionId, text });
  return sessionId;
}

// The prompt of each turn's first step, in turn order.
function turnPrompts(m: MockLanguageModelV4): LanguageModelV4Prompt[] {
  return m.doGenerateCalls.filter((c) => c.tools?.length && c.prompt.at(-1)!.role === "user").map((c) => c.prompt);
}

function summaryCalls(m: MockLanguageModelV4) {
  return m.doGenerateCalls.filter((c) => !c.tools?.length);
}

function toolResults(prompt: LanguageModelV4Prompt): string[] {
  return prompt.flatMap((m) =>
    m.role === "tool" ? m.content.flatMap((p) => (p.type === "tool-result" && p.output.type === "text" ? [p.output.value] : [])) : [],
  );
}

function userTexts(prompt: LanguageModelV4Prompt): string[] {
  return prompt.flatMap((m) => (m.role === "user" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])) : []));
}

const full = (r: string) => r.includes("o".repeat(OUTPUT_CHARS));

test("past the mask threshold, old tool output is sent as a short marker and the newest turn's stays", async () => {
  const m = scripted();
  const d = deps(m, new Store(":memory:"), { maskBytes: 1, summaryBytes: Infinity });
  await alert(d, "alert 1");
  await alert(d, "alert 2");
  await alert(d, "alert 3");

  const results = toolResults(turnPrompts(m)[2]!);
  expect(results).toHaveLength(2);
  expect(full(results[0]!)).toBe(false);
  expect(results[0]!.length).toBeLessThan(200);
  expect(full(results[1]!)).toBe(true);
  expect(summaryCalls(m)).toHaveLength(0);
});

test("under the mask threshold, old tool output is sent whole", async () => {
  const m = scripted();
  const d = deps(m, new Store(":memory:"), off);
  await alert(d, "alert 1");
  await alert(d, "alert 2");
  await alert(d, "alert 3");

  expect(toolResults(turnPrompts(m)[2]!).map(full)).toEqual([true, true]);
});

test("past the summary threshold, a summary replaces the oldest turns, and the stored messages stay whole", async () => {
  const m = scripted();
  const store = new Store(":memory:");
  const d = deps(m, store, { maskBytes: 1, summaryBytes: 1 });
  await alert(d, "alert 1");
  await alert(d, "alert 2");
  const sessionId = await alert(d, "alert 3");

  // The newest turn is never summarized, so the second turn has nothing to
  // summarize and the third summarizes the first.
  expect(summaryCalls(m)).toHaveLength(1);
  const texts = userTexts(turnPrompts(m)[2]!);
  expect(texts[0]).toContain("summary 0");
  expect(texts.some((t) => t.includes("alert 1"))).toBe(false);
  expect(texts.some((t) => t === "alert 2")).toBe(true);
  expect(texts.at(-1)).toBe("alert 3");

  const stored = JSON.stringify(store.messages(sessionId));
  expect(stored).toContain("alert 1");
  expect(stored).toContain("o".repeat(OUTPUT_CHARS));
  expect(stored).not.toContain("summary 0");

  // A later change of threshold applies to the stored messages.
  const next = scripted();
  await alert(deps(next, store, off), "alert 4");
  const prompt = turnPrompts(next)[0]!;
  expect(userTexts(prompt)).toEqual(["alert 1", "alert 2", "alert 3", "alert 4"]);
  expect(toolResults(prompt).map(full)).toEqual([true, true, true]);
  expect(summaryCalls(next)).toHaveLength(0);
});

test("a summary is reused until the turns after it pass the threshold again, and the next one builds on it", async () => {
  const m = scripted();
  // Two turns fit and three do not, since each holds one tool output of
  // OUTPUT_CHARS.
  const d = deps(m, new Store(":memory:"), { maskBytes: Infinity, summaryBytes: OUTPUT_CHARS * 2.6 });
  await alert(d, "alert 1");
  await alert(d, "alert 2");
  await alert(d, "alert 3");
  expect(summaryCalls(m)).toHaveLength(0);

  await alert(d, "alert 4");
  expect(summaryCalls(m)).toHaveLength(1);
  expect(userTexts(turnPrompts(m)[3]!).slice(1)).toEqual(["alert 3", "alert 4"]);

  await alert(d, "alert 5");
  expect(summaryCalls(m)).toHaveLength(1);
  const texts = userTexts(turnPrompts(m)[4]!);
  expect(texts[0]).toContain("summary 0");
  expect(texts.slice(1)).toEqual(["alert 3", "alert 4", "alert 5"]);

  await alert(d, "alert 6");
  const calls = summaryCalls(m);
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(calls[1]!.prompt)).toContain("summary 0");
});

test("the summary call is charged to the turn", async () => {
  // A summary call reports 1M output tokens, 15 USD, and every other call none.
  const m = scripted({ ...zero, outputTokens: { total: 1_000_000, text: 1_000_000, reasoning: 0 } });
  const store = new Store(":memory:");
  const d = deps(m, store, { maskBytes: 1, summaryBytes: 1 });
  d.turnCapUsd = 100;
  d.monthlyCapUsd = 100;
  await alert(d, "alert 1");
  await alert(d, "alert 2");
  expect(store.monthSpend("2026-10")).toBe(0);

  const { sessionId, turnId } = store.noteFiring({ alertname: "KubePodCrashLooping", namespace: "example-app" }, [String(fingerprint++)], "alert 3");
  await runTurn(d, { id: turnId!, sessionId, text: "alert 3" });
  expect(summaryCalls(m)).toHaveLength(1);
  expect(store.turnSpend(turnId!)).toBeCloseTo(15, 6);
  expect(store.monthSpend("2026-10")).toBeCloseTo(15, 6);
});

test("a summary cut by its token limit fails the attempt and is not stored", async () => {
  const store = new Store(":memory:");
  const d = deps(scripted(), store, off);
  await alert(d, "alert 1");
  const sessionId = await alert(d, "alert 2");

  const cut = deps(scripted(zero, "length"), store, { maskBytes: 1, summaryBytes: 1 });
  const { turnId } = store.noteFiring({ alertname: "KubePodCrashLooping", namespace: "example-app" }, [String(fingerprint++)], "alert 3");
  await expect(runTurn(cut, { id: turnId!, sessionId, text: "alert 3" })).rejects.toThrow();
  expect(store.summaries(sessionId)).toEqual([]);
  expect(store.pending()).toHaveLength(1);
});
