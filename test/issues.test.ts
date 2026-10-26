import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { z } from "zod";
import { runTurn, type AgentDeps } from "../src/agent";
import { GoneIssue, githubApi, IssueQueue, Refused, type IssueApi } from "../src/issues";
import { Store } from "../src/store";
import { readTool, type ReadTool } from "../src/tools";

const zero = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

// A model that makes the given tool call once, if any, then answers.
function model(answer: string, call?: { tool: string; input: Record<string, unknown> }) {
  return new MockLanguageModelV4({
    doGenerate: async (o: LanguageModelV4CallOptions) => {
      if (!call || o.prompt.at(-1)!.role === "tool") {
        return { content: [{ type: "text", text: answer }], finishReason: { unified: "stop", raw: "end_turn" }, usage: zero, warnings: [] };
      }
      return {
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: call.tool, input: JSON.stringify(call.input) }],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: zero,
        warnings: [],
      };
    },
  });
}

function deps(store: Store, m: MockLanguageModelV4, tools: Record<string, ReadTool> = {}): AgentDeps {
  return {
    model: m,
    price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    turnCapUsd: 5,
    monthlyCapUsd: 50,
    store,
    instructions: async () => "",
    now: () => new Date("2026-10-27T03:00:00Z"),
    tools,
    stepTimeoutMs: 60_000,
    compaction: { maskBytes: Infinity, summaryBytes: Infinity },
  };
}

const key = { alertname: "KubeJobFailed", namespace: "example-app" };

let fingerprint = 0;
// Runs one turn on the group's session to its end.
async function turn(store: Store, text: string, m: MockLanguageModelV4, tools?: Record<string, ReadTool>) {
  const { sessionId, turnId } = store.noteFiring(key, [String(fingerprint++)], text);
  await runTurn(deps(store, m, tools), { id: turnId!, sessionId, text });
}

// Records what the queue writes. fail, when set, decides whether a call throws.
// lose, when set, makes the next open create the issue and then fail, as a
// response lost on the way back does.
function fakeGitHub() {
  const issues: { number: number; title: string; body: string }[] = [];
  const comments: { issue: number; body: string }[] = [];
  const api = {
    fail: null as null | ((call: "open" | "comment") => Error | null),
    lose: false as boolean,
    async open(title: string, body: string) {
      const e = api.fail?.("open");
      if (e) throw e;
      issues.push({ number: issues.length + 1, title, body });
      if (api.lose) {
        api.lose = false;
        throw new Error("socket closed");
      }
      return issues.length;
    },
    async comment(issue: number, body: string) {
      const e = api.fail?.("comment");
      if (e) throw e;
      comments.push({ issue, body });
    },
    async find(marker: string) {
      return issues.find((i) => i.body.includes(marker))?.number ?? null;
    },
  } satisfies IssueApi & { fail: unknown; lose: boolean };
  return { api, issues, comments };
}

function setup(linkHosts: string[] = []) {
  const store = new Store(":memory:");
  const github = fakeGitHub();
  const queue = new IssueQueue({ store, api: github.api, linkHosts: new Set(linkHosts) });
  return { store, queue, ...github };
}

test("a session's first finished turn opens one issue and a later turn comments on it", async () => {
  const { store, queue, issues, comments } = setup();
  await turn(store, "first alert", model("first answer"));
  await turn(store, "second alert", model("second answer"));
  await queue.flush();

  expect(issues).toHaveLength(1);
  expect(issues[0]!.title).toBe("KubeJobFailed / example-app");
  expect(issues[0]!.body).toContain("first answer");
  expect(comments).toEqual([{ issue: 1, body: expect.stringContaining("second answer") }]);
});

// The text of each fenced block in a markdown body, with the line before it.
// As in CommonMark, a line of at least as many backticks closes a fence.
function fenced(body: string): { before: string; text: string }[] {
  const out: { before: string; text: string }[] = [];
  const re = /(^|\n)([^\n]*)\n(`{3,})[^\n]*\n([\s\S]*?)\n\3`*(?=\n|$)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out.push({ before: m[2]!, text: m[4]! });
  return out;
}

test("stranger text sits in a fenced block marked as quoted alert data, redacted and without links", async () => {
  const { store, queue, issues } = setup();
  const alert = [
    "summary: backup failed ```",
    "````",
    "description: see https://evil.example.com/x?d=1 token=abcd1234secretvalue",
  ].join("\n");
  await turn(store, alert, model("answer"));
  await queue.flush();

  const quoted = fenced(issues[0]!.body).find((b) => b.text.includes("backup failed"));
  expect(quoted?.before.toLowerCase()).toContain("quoted alert data");
  expect(quoted!.text).toBe(
    ["summary: backup failed ```", "````", "description: see [link removed] token=[redacted]"].join("\n"),
  );
});

test("the answer is redacted and loses links and images whose host is off the allowlist", async () => {
  const { store, queue, issues } = setup(["grafana.example.com"]);
  const answer = [
    "**Cause**: the job ran out of memory.",
    "- dashboard: https://grafana.example.com/d/abc",
    "- [details](https://evil.example.com/a?d=secret-data)",
    "- ![chart](//evil.example.com/p.png)",
    '- <img src="https://evil.example.com/q.png">',
    "- www.evil.example.com/r",
    "- [ref]",
    "",
    "[ref]: https://evil.example.com/s",
    "- api_key=abcd1234secretvalue",
  ].join("\n");
  await turn(store, "alert", model(answer));
  await queue.flush();

  const body = issues[0]!.body;
  expect(body).toContain("**Cause**: the job ran out of memory.");
  expect(body).toContain("https://grafana.example.com/d/abc");
  expect(body).not.toContain("evil.example.com");
  expect(body).not.toContain("abcd1234secretvalue");
  // No markdown link, image or HTML tag can form from the answer.
  expect(body).not.toMatch(/\]\(|\]:|<img/i);
});

test("the issue lists each query the turn ran with its time range", async () => {
  const { store, queue, issues } = setup();
  const promql_range = readTool({
    description: "Runs a range query.",
    input: z.object({ query: z.string(), start: z.string() }),
    run: async ({ query }) => ({ query, start: "2026-10-27T02:30:00.000Z", end: "2026-10-27T03:00:00.000Z", result: [] }),
  });
  const call = { tool: "promql_range", input: { query: 'up{job="example"}', start: "30m" } };
  await turn(store, "alert", model("answer", call), { promql_range });
  await queue.flush();

  const query = fenced(issues[0]!.body).find((b) => b.text.includes("promql_range"));
  expect(query!.text).toContain('up{job=\\"example\\"}');
  expect(query!.text).toContain("2026-10-27T02:30:00.000Z");
  expect(query!.text).toContain("2026-10-27T03:00:00.000Z");
});

test("a write that fails for a passing reason stays queued and the next flush sends it", async () => {
  const { store, queue, api, issues, comments } = setup();
  await turn(store, "first alert", model("first answer"));
  await turn(store, "second alert", model("second answer"));
  api.fail = () => new Error("503 Service Unavailable");
  await queue.flush();
  expect(issues).toHaveLength(0);

  api.fail = null;
  await queue.flush();
  expect(issues).toHaveLength(1);
  expect(comments).toHaveLength(1);
});

test("a retry after a lost response finds the issue instead of opening another", async () => {
  const { store, queue, api, issues, comments } = setup();
  await turn(store, "first alert", model("first answer"));
  await turn(store, "second alert", model("second answer"));
  api.lose = true;
  await queue.flush();
  await queue.flush();

  expect(issues).toHaveLength(1);
  expect(comments).toEqual([{ issue: 1, body: expect.stringContaining("second answer") }]);
});

test("a write GitHub refuses is dropped and the next one goes out", async () => {
  const { store, queue, api, issues } = setup();
  await turn(store, "first alert", model("first answer"));
  await turn(store, "second alert", model("second answer"));
  let refused = false;
  api.fail = () => (refused ? null : ((refused = true), new Refused("422 Validation Failed")));
  await queue.flush();

  expect(issues).toEqual([expect.objectContaining({ body: expect.stringContaining("second answer") })]);
});

test("a comment on a deleted issue opens a new issue", async () => {
  const { store, queue, api, issues, comments } = setup();
  await turn(store, "first alert", model("first answer"));
  await queue.flush();
  await turn(store, "second alert", model("second answer"));
  api.fail = (call) => (call === "comment" ? new GoneIssue("410 Gone") : null);
  await queue.flush();

  expect(comments).toHaveLength(0);
  expect(issues.map((i) => i.number)).toEqual([1, 2]);
  expect(issues[1]!.body).toContain("second answer");
});

// A GitHub API fake. respond, when set, answers an issue call first.
const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.stop(true)));

function fakeApi() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const seen: { method: string; path: string; auth: string; body: unknown }[] = [];
  let tokens = 0;
  const state = {
    respond: null as null | ((path: string) => Response | null),
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const { pathname } = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";
      const body = req.method === "POST" ? await req.json() : null;
      seen.push({ method: req.method, path: pathname, auth, body });
      if (pathname === "/repos/example-owner/example-repo/installation") return Response.json({ id: 7 });
      if (pathname === "/app/installations/7/access_tokens") {
        tokens++;
        return Response.json({ token: `installation-${tokens}`, expires_at: "2026-10-27T04:00:00Z" }, { status: 201 });
      }
      const r = state.respond?.(pathname);
      if (r) return r;
      if (pathname === "/repos/example-owner/example-repo/issues" && req.method === "POST") {
        return Response.json({ number: 12 }, { status: 201 });
      }
      if (pathname.endsWith("/comments")) return Response.json({ id: 1 }, { status: 201 });
      if (pathname === "/repos/example-owner/example-repo/issues") {
        return Response.json([{ number: 9, body: "other" }, { number: 8, body: "x\n<!-- ops-agent:m-1 -->" }]);
      }
      return new Response(null, { status: 404 });
    },
  });
  servers.push(server);
  const api = githubApi({
    apiUrl: server.url.href.replace(/\/$/, ""),
    appId: "12345",
    key: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    repo: "example-owner/example-repo",
    now: () => new Date("2026-10-27T03:00:00Z"),
  });
  return { api, seen, state, publicKey };
}

test("the client signs a JWT as the app and writes with an installation token scoped to the repository", async () => {
  const { api, seen, publicKey } = fakeApi();
  expect(await api.open("title", "body")).toBe(12);
  await api.comment(12, "later");

  const lookup = seen.find((s) => s.path.endsWith("/installation"))!;
  const [head, payload, sig] = lookup.auth.replace(/^Bearer /, "").split(".");
  expect(verify("sha256", Buffer.from(`${head}.${payload}`), publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ iss: "12345" });

  const tokenCalls = seen.filter((s) => s.path.endsWith("/access_tokens"));
  expect(tokenCalls).toHaveLength(1);
  expect(tokenCalls[0]!.body).toEqual({ repositories: ["example-repo"], permissions: { issues: "write" } });

  const writes = seen.filter((s) => s.path.startsWith("/repos/example-owner/example-repo/issues"));
  expect(writes.map((w) => [w.path, w.auth, w.body])).toEqual([
    ["/repos/example-owner/example-repo/issues", "Bearer installation-1", { title: "title", body: "body" }],
    ["/repos/example-owner/example-repo/issues/12/comments", "Bearer installation-1", { body: "later" }],
  ]);
});

test("a token GitHub rejects is replaced on the next call", async () => {
  const { api, seen, state } = fakeApi();
  let rejected = false;
  state.respond = () => (rejected ? null : ((rejected = true), new Response(null, { status: 401 })));
  await expect(api.open("title", "body")).rejects.toThrow();
  await api.open("title", "body");
  expect(seen.filter((s) => s.path.endsWith("/access_tokens"))).toHaveLength(2);
});

test("the client finds a recent issue by its marker", async () => {
  const { api } = fakeApi();
  expect(await api.find("m-1")).toBe(8);
  expect(await api.find("m-2")).toBeNull();
});

test("GitHub's answers map to refused, gone, or worth a retry", async () => {
  const { api, state } = fakeApi();
  const answer = (status: number, headers: Record<string, string> = {}) => {
    state.respond = () => new Response(null, { status, headers });
  };
  answer(422);
  await expect(api.open("t", "b")).rejects.toBeInstanceOf(Refused);
  answer(410);
  await expect(api.comment(1, "b")).rejects.toBeInstanceOf(GoneIssue);
  answer(404);
  await expect(api.comment(1, "b")).rejects.toBeInstanceOf(GoneIssue);
  for (const [status, headers] of [
    [403, { "x-ratelimit-remaining": "0" }],
    [403, { "retry-after": "60" }],
    [429, {}],
    [502, {}],
  ] as const) {
    answer(status, headers);
    const e = await api.open("t", "b").catch((e) => e);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(Refused);
    expect(e).not.toBeInstanceOf(GoneIssue);
  }
});

test("a query whose result was cut at the size limit keeps its time range", async () => {
  const { store, queue, issues } = setup();
  const promql_range = readTool({
    description: "Runs a range query.",
    input: z.object({ query: z.string(), start: z.string() }),
    run: async ({ query }) => ({
      query,
      start: "2026-10-27T02:30:00.000Z",
      end: "2026-10-27T03:00:00.000Z",
      result: Array.from({ length: 2_000 }, (_, i) => ({ labels: { pod: `example-${i}` }, value: "1" })),
    }),
  });
  await turn(store, "alert", model("answer", { tool: "promql_range", input: { query: "up", start: "30m" } }), { promql_range });
  await queue.flush();

  const query = fenced(issues[0]!.body).find((b) => b.text.includes("promql_range"));
  expect(query!.text).toContain("2026-10-27T02:30:00.000Z");
  expect(query!.text).toContain("2026-10-27T03:00:00.000Z");
});

test("a body stays under GitHub's limit when cleaning lengthens every part, and a token at a cut is still redacted", async () => {
  const { store, queue, issues } = setup();
  const token = `ghp_${"A".repeat(36)}`;
  const answer = `${"[a](b) <x ".repeat(4_000).slice(0, 39_995)} ${token} ${"[a](b) <x ".repeat(4_000)}`;
  const alert = "<y ](z ".repeat(5_000);
  await turn(store, alert, model(answer));
  await queue.flush();

  const body = issues[0]!.body;
  expect(body.length).toBeLessThanOrEqual(65_536);
  expect(body).not.toContain("ghp_");
});
