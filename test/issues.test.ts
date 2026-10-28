import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { z } from "zod";
import { runTurn, type AgentDeps } from "../src/agent/turn";
import { GoneIssue, githubApi, IssueQueue, issueRepositoryTool, issueSummaryTool, Refused, type Handoff, type IssueApi } from "../src/owner/issues";
import { Metrics } from "../src/metrics";
import { Outbox, type DiscordApi } from "../src/owner/discord";
import { Store } from "../src/store";
import { readTool, type ReadTool } from "../src/tools/contract";

const zero = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

// A model that makes the given tool calls in this turn, one per step, then
// answers.
function model(answer: string, ...calls: { tool: string; input: Record<string, unknown> }[]) {
  return new MockLanguageModelV4({
    doGenerate: async (o: LanguageModelV4CallOptions) => {
      const step = o.prompt.length - 1 - o.prompt.findLastIndex((m) => m.role === "user");
      const call = calls[Math.floor(step / 2)];
      if (!call) {
        return { content: [{ type: "text", text: answer }], finishReason: { unified: "stop", raw: "end_turn" }, usage: zero, warnings: [] };
      }
      return {
        content: [{ type: "tool-call", toolCallId: `call-${step}`, toolName: call.tool, input: JSON.stringify(call.input) }],
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
    metrics: new Metrics(),
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
// Issue numbers count across repositories.
function fakeGitHub() {
  const issues: { repo: string; number: number; title: string; body: string }[] = [];
  const edits: { repo: string; issue: number; body: string }[] = [];
  const closed = new Set<string>();
  const api = {
    fail: null as null | ((call: "open" | "edit" | "isClosed") => Error | null),
    lose: false as boolean,
    async open(repo: string, title: string, body: string) {
      const e = api.fail?.("open");
      if (e) throw e;
      issues.push({ repo, number: issues.length + 1, title, body });
      if (api.lose) {
        api.lose = false;
        throw new Error("socket closed");
      }
      return issues.length;
    },
    async edit(repo: string, issue: number, body: string) {
      const e = api.fail?.("edit");
      if (e) throw e;
      edits.push({ repo, issue, body });
      issues.find((i) => i.repo === repo && i.number === issue)!.body = body;
    },
    async find(repo: string, marker: string) {
      return issues.find((i) => i.repo === repo && i.body.includes(marker))?.number ?? null;
    },
    async isClosed(repo: string, issue: number) {
      const e = api.fail?.("isClosed");
      if (e) throw e;
      return closed.has(`${repo}#${issue}`);
    },
  } satisfies IssueApi & { fail: unknown; lose: boolean };
  // The owner closes the issue on GitHub.
  const close = (repo: string, issue: number) => void closed.add(`${repo}#${issue}`);
  return { api, issues, edits, close };
}

const REPOS = ["example-owner/example-apps", "example-owner/example-platform", "example-owner/example-hosts"];

function setup(linkHosts: string[] = []) {
  const store = new Store(":memory:");
  const github = fakeGitHub();
  const queue = new IssueQueue({ store, api: github.api, linkHosts: new Set(linkHosts), repos: REPOS });
  return { store, queue, ...github };
}

const recordTool = issueRepositoryTool(["example-apps", "example-platform", "example-hosts"]);
const name = (repo: string) => ({ tool: "issue_repository", input: { repo } });

const summaryTool = issueSummaryTool();
const summary = (symptom: string, cause: string, title = "example title") => ({ tool: "issue_summary", input: { title, symptom, cause } });

// The text under each `### ` heading of an issue body, keyed by the heading.
function sections(body: string): Record<string, string> {
  return Object.fromEntries(
    [...body.matchAll(/^### (.+)\n\n([\s\S]*?)(?=\n\n### |\n\n<!--|$)/gm)].map((m) => [m[1]!, m[2]!]),
  );
}

test("the issue holds the symptom and cause the model recorded, and no stopgap while none ran", async () => {
  const { store, queue, issues } = setup();
  await turn(store, "alert", model("answer", summary("The backup job failed twice.", "The job ran out of memory.")), summaryTool);
  await queue.flush();

  expect(issues).toHaveLength(1);
  expect(issues[0]!.title).toBe("KubeJobFailed / example-app");
  expect(sections(issues[0]!.body)).toEqual({
    Symptom: "The backup job failed twice.",
    Cause: "The job ran out of memory.",
    Actions: "No stopgap taken.",
  });
});

test("the title the model recorded in the first turn names the alert's Discord thread", async () => {
  const { store } = setup();
  const names: string[] = [];
  const discord: DiscordApi = {
    openThread: async (_channel, message, name) => (names.push(name), message),
    send: async (_channel, m) => (names.length === 0 && names.push(`starter: ${m.content}`), "msg"),
    typing: async () => {},
    archive: async () => {},
  };
  await turn(store, "alert", model("answer", summary("symptom", "cause", "backup job runs out of memory")), summaryTool);
  await new Outbox({ store, api: discord, channelId: "100", linkHosts: new Set() }).flush();

  expect(names).toEqual([
    "starter: KubeJobFailed / example-app: backup job runs out of memory",
    "KubeJobFailed / example-app: backup job runs out of memory",
  ]);
});

test("a summary without a title is refused", async () => {
  const { store, queue, issues } = setup();
  const untitled = { tool: "issue_summary", input: { symptom: "untitled symptom", cause: "untitled cause" } };
  await turn(store, "alert", model("answer", untitled), summaryTool);
  await queue.flush();

  expect(sections(issues[0]!.body).Cause).toBe("answer");
});

test("a later turn replaces the issue's body instead of adding to it", async () => {
  const { store, queue, issues, edits } = setup();
  await turn(store, "first alert", model("first answer", summary("first symptom", "first cause")), summaryTool);
  await queue.flush();
  await turn(store, "The owner replied", model("second answer", summary("second symptom", "second cause")), summaryTool);
  await queue.flush();

  expect(issues).toHaveLength(1);
  expect(edits.map((e) => [e.repo, e.issue])).toEqual([["example-owner/example-apps", 1]]);
  expect(sections(issues[0]!.body)).toMatchObject({ Symptom: "second symptom", Cause: "second cause" });
  expect(issues[0]!.body).not.toContain("first");
});

test("the turn's last summary wins, and one the schema refused changes nothing", async () => {
  const { store, queue, issues } = setup();
  const refused = { tool: "issue_summary", input: { symptom: "refused symptom" } };
  await turn(store, "alert", model("answer", summary("early symptom", "early cause"), summary("late symptom", "late cause"), refused), summaryTool);
  await queue.flush();

  expect(sections(issues[0]!.body)).toMatchObject({ Symptom: "late symptom", Cause: "late cause" });
});

test("a turn with no summary writes the alert group and its firing count as the symptom and the answer as the cause", async () => {
  const { store, queue, issues } = setup();
  const { sessionId, turnId } = store.noteFiring(key, ["a", "b"], "alert");
  await runTurn(deps(store, model("The job ran out of memory.")), { id: turnId!, sessionId, text: "alert" });
  await queue.flush();

  expect(sections(issues[0]!.body)).toEqual({
    Symptom: "KubeJobFailed in example-app, 2 alerts firing.",
    Cause: "The job ran out of memory.",
    Actions: "No stopgap taken.",
  });
});

test("a cluster-wide group's fallback symptom names no namespace", async () => {
  const { store, queue, issues } = setup();
  const { sessionId, turnId } = store.noteFiring({ alertname: "KubeNodeNotReady", namespace: null }, ["a"], "alert");
  await runTurn(deps(store, model("answer")), { id: turnId!, sessionId, text: "alert" });
  await queue.flush();

  expect(sections(issues[0]!.body).Symptom).toBe("KubeNodeNotReady, cluster-wide, 1 alert firing.");
});

test("a turn with no summary falls back even when an earlier turn recorded one", async () => {
  const { store, queue, issues } = setup();
  await turn(store, "first alert", model("first answer", summary("first symptom", "first cause")), summaryTool);
  await turn(store, "The owner replied", model("second answer"), summaryTool);
  await queue.flush();

  expect(sections(issues[0]!.body)).toMatchObject({ Symptom: "KubeJobFailed in example-app, 1 alert firing.", Cause: "second answer" });
});

test("a turn stopped before its answer and summary leaves an earlier cause in place", async () => {
  const { store, queue, issues, edits } = setup();
  await turn(store, "first alert", model("first answer", summary("first symptom", "first cause")), summaryTool);
  await queue.flush();
  await turn(store, "The owner replied", model(""), summaryTool);
  await queue.flush();

  expect(edits).toHaveLength(0);
  expect(sections(issues[0]!.body)).toMatchObject({ Cause: "first cause" });
});

test("a session's first turn stopped before its answer still opens the issue", async () => {
  const { store, queue, issues } = setup();
  await turn(store, "alert", model(""), summaryTool);
  await queue.flush();

  expect(issues).toHaveLength(1);
});

test("a hand-off queued before sections existed is written with its answer as the cause", async () => {
  const { store, queue, issues } = setup();
  const { turnId } = store.noteFiring(key, ["a"], "alert");
  const old = { input: "alert", answer: "old answer", queries: [] };
  store.endTurn(turnId!, "done", [], "old answer", old as unknown as Handoff);
  await turn(store, "second alert", model("second answer"));
  await queue.flush();

  expect(issues).toHaveLength(1);
  expect(issues[0]!.body).toContain("second answer");
});

test("model text cannot form a heading, so it cannot fake the Actions section", async () => {
  const { store, queue, issues } = setup();
  const cause = ["The job ran out of memory.", "", "### Actions", "", "Scaled example-app to zero.", "", "Actions", "---", "", "Actions", "==="].join("\n");
  await turn(store, "alert", model("answer", summary("symptom", cause)), summaryTool);
  await queue.flush();

  const body = issues[0]!.body;
  expect(body.match(/^ {0,3}#{1,6}\s/gm)).toEqual(["### ", "### ", "### "]);
  expect(body).not.toMatch(/\n[^\n]+\n {0,3}(-+|=+) *(\n|$)/);
});

test("the issue quotes neither the alert data nor the turn's queries", async () => {
  const { store, queue, issues } = setup();
  const promql = readTool({
    description: "Runs a query.",
    input: z.object({ query: z.string() }),
    run: async ({ query }) => ({ query, result: [] }),
  });
  await turn(store, "alert-data-sentinel", model("answer", { tool: "promql", input: { query: "query-sentinel" } }), { promql });
  await queue.flush();

  expect(issues[0]!.body).not.toContain("alert-data-sentinel");
  expect(issues[0]!.body).not.toContain("query-sentinel");
});

test("the issue opens on the repository the model last named, and a name off the list changes nothing", async () => {
  const { store, queue, issues } = setup();
  await turn(store, "alert", model("answer", name("example-hosts"), name("example-platform"), name("example-other")), recordTool);
  await queue.flush();

  expect(issues.map((i) => i.repo)).toEqual(["example-owner/example-platform"]);
  // Recording the repository is not a query of the cluster.
  expect(issues[0]!.body).not.toContain("issue_repository");
});

test("naming a repository again after another still makes it the last named", async () => {
  const { store, queue, issues } = setup();
  await turn(store, "alert", model("answer", name("example-hosts"), name("example-platform"), name("example-hosts")), recordTool);
  await queue.flush();

  expect(issues.map((i) => i.repo)).toEqual(["example-owner/example-hosts"]);
});

test("the session's first write fixes its repository, and a later turn's name is ignored", async () => {
  const { store, queue, issues, edits } = setup();
  await turn(store, "first alert", model("first answer"), recordTool);
  await queue.flush();
  await turn(store, "second alert", model("second answer", name("example-hosts")), recordTool);
  await queue.flush();

  expect(issues.map((i) => i.repo)).toEqual(["example-owner/example-apps"]);
  expect(edits.map((e) => e.repo)).toEqual(["example-owner/example-apps"]);
});

test("an issue reopened after a deletion opens on the session's repository", async () => {
  const { store, queue, api, issues } = setup();
  await turn(store, "first alert", model("first answer", name("example-hosts")), recordTool);
  await queue.flush();
  await turn(store, "second alert", model("second answer", name("example-platform")), recordTool);
  api.fail = (call) => (call === "edit" ? new GoneIssue("410 Gone") : null);
  await queue.flush();

  expect(issues.map((i) => i.repo)).toEqual(["example-owner/example-hosts", "example-owner/example-hosts"]);
});

test("each section is redacted and loses links and images whose host is off the allowlist", async () => {
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
  await turn(store, "alert", model("answer", summary(answer, answer)), summaryTool);
  await queue.flush();

  const body = issues[0]!.body;
  expect(body).toContain("**Cause**: the job ran out of memory.");
  expect(body).toContain("https://grafana.example.com/d/abc");
  expect(body).not.toContain("evil.example.com");
  expect(body).not.toContain("abcd1234secretvalue");
  // No markdown link, image or HTML tag can form from a section.
  expect(body).not.toMatch(/\]\(|\]:|<img/i);
});

test("a write that fails for a passing reason stays queued and the next flush sends it", async () => {
  const { store, queue, api, issues, edits } = setup();
  await turn(store, "first alert", model("first answer"));
  await turn(store, "second alert", model("second answer"));
  api.fail = () => new Error("503 Service Unavailable");
  await queue.flush();
  expect(issues).toHaveLength(0);

  api.fail = null;
  await queue.flush();
  expect(issues).toHaveLength(1);
  expect(edits).toHaveLength(1);
  expect(issues[0]!.body).toContain("second answer");
});

test("a retry after a lost response finds the issue instead of opening another", async () => {
  const { store, queue, api, issues } = setup();
  await turn(store, "first alert", model("first answer"));
  await turn(store, "second alert", model("second answer"));
  api.lose = true;
  await queue.flush();
  await queue.flush();

  expect(issues).toHaveLength(1);
  expect(issues[0]!.body).toContain("second answer");
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

test("an edit of a deleted issue opens a new issue", async () => {
  const { store, queue, api, issues, edits } = setup();
  await turn(store, "first alert", model("first answer"));
  await queue.flush();
  await turn(store, "second alert", model("second answer"));
  api.fail = (call) => (call === "edit" ? new GoneIssue("410 Gone") : null);
  await queue.flush();

  expect(edits).toHaveLength(0);
  expect(issues.map((i) => i.number)).toEqual([1, 2]);
  expect(issues[1]!.body).toContain("second answer");
});

test("an issue the owner closed ends its session, and the group's next alert opens a new issue that names the closed one", async () => {
  const { store, queue, issues, edits, close } = setup();
  await turn(store, "first alert", model("first answer", name("example-hosts")), recordTool);
  await queue.flush();
  close("example-owner/example-hosts", 1);
  await queue.watch();

  await turn(store, "second alert", model("second answer"), recordTool);
  await queue.flush();

  expect(edits).toHaveLength(0);
  expect(issues.map((i) => [i.repo, i.number])).toEqual([
    ["example-owner/example-hosts", 1],
    ["example-owner/example-apps", 2],
  ]);
  expect(issues[0]!.body).toContain("first answer");
  expect(issues[1]!.body).toContain("example-owner/example-hosts#1");
  expect(sections(issues[1]!.body)).toMatchObject({ Cause: "second answer" });
});

test("an issue still open keeps its session, and the next alert edits it", async () => {
  const { store, queue, issues, edits } = setup();
  await turn(store, "first alert", model("first answer"));
  await queue.flush();
  await queue.watch();
  await turn(store, "second alert", model("second answer"));
  await queue.flush();

  expect(issues).toHaveLength(1);
  expect(edits).toHaveLength(1);
});

test("a closed issue's session stays open while it has a turn or a write pending", async () => {
  const { store, queue, issues, close } = setup();
  await turn(store, "first alert", model("first answer"));
  await queue.flush();
  close("example-owner/example-apps", 1);
  const { sessionId, turnId } = store.noteFiring(key, [String(fingerprint++)], "second alert");
  await queue.watch();
  expect(store.isClosed(sessionId)).toBe(false);
  await runTurn(deps(store, model("second answer")), { id: turnId!, sessionId, text: "second alert" });
  await queue.watch();
  expect(store.isClosed(sessionId)).toBe(false);
  await queue.flush();
  await queue.watch();
  expect(store.isClosed(sessionId)).toBe(true);

  expect(issues).toHaveLength(1);
  expect(issues[0]!.body).toContain("second answer");
});

test("a failed state check leaves the session open, and the next check closes it", async () => {
  const { store, queue, api, issues, close } = setup();
  await turn(store, "first alert", model("first answer"));
  await queue.flush();
  close("example-owner/example-apps", 1);
  api.fail = (call) => (call === "isClosed" ? new Error("503 Service Unavailable") : null);
  await queue.watch();
  await turn(store, "second alert", model("second answer"));
  await queue.flush();
  expect(issues).toHaveLength(1);

  api.fail = null;
  await queue.watch();
  await turn(store, "third alert", model("third answer"));
  await queue.flush();
  expect(issues).toHaveLength(2);
});

test("a deleted issue is no longer checked, and the next write opens a new one", async () => {
  const { store, queue, api, issues } = setup();
  await turn(store, "first alert", model("first answer"));
  await queue.flush();
  let checks = 0;
  api.fail = (call) => (call === "isClosed" ? (checks++, new GoneIssue("410 Gone")) : null);
  await queue.watch();
  await queue.watch();
  api.fail = null;
  await turn(store, "second alert", model("second answer"));
  await queue.flush();

  expect(checks).toBe(1);
  expect(issues.map((i) => i.number)).toEqual([1, 2]);
});

const REPO = "example-owner/example-repo";

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
      const body = req.method === "POST" || req.method === "PATCH" ? await req.json() : null;
      seen.push({ method: req.method, path: pathname, auth, body });
      if (/^\/repos\/example-owner\/[\w-]+\/installation$/.test(pathname)) return Response.json({ id: 7 });
      if (pathname === "/app/installations/7/access_tokens") {
        tokens++;
        return Response.json({ token: `installation-${tokens}`, expires_at: "2026-10-27T04:00:00Z" }, { status: 201 });
      }
      const r = state.respond?.(pathname);
      if (r) return r;
      if (/^\/repos\/example-owner\/[\w-]+\/issues$/.test(pathname) && req.method === "POST") {
        return Response.json({ number: 12 }, { status: 201 });
      }
      if (/^\/repos\/example-owner\/[\w-]+\/issues\/\d+$/.test(pathname) && req.method === "PATCH") {
        return Response.json({ number: Number(pathname.split("/").pop()) });
      }
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
    now: () => new Date("2026-10-27T03:00:00Z"),
  });
  return { api, seen, state, publicKey };
}

test("the client signs a JWT as the app and writes with an installation token scoped to the repository", async () => {
  const { api, seen, publicKey } = fakeApi();
  expect(await api.open(REPO, "title", "body")).toBe(12);
  await api.edit(REPO, 12, "later");

  const lookup = seen.find((s) => s.path.endsWith("/installation"))!;
  const [head, payload, sig] = lookup.auth.replace(/^Bearer /, "").split(".");
  expect(verify("sha256", Buffer.from(`${head}.${payload}`), publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ iss: "12345" });

  const tokenCalls = seen.filter((s) => s.path.endsWith("/access_tokens"));
  expect(tokenCalls).toHaveLength(1);
  expect(tokenCalls[0]!.body).toEqual({ repositories: ["example-repo"], permissions: { issues: "write" } });

  const writes = seen.filter((s) => s.path.startsWith("/repos/example-owner/example-repo/issues"));
  expect(writes.map((w) => [w.method, w.path, w.auth, w.body])).toEqual([
    ["POST", "/repos/example-owner/example-repo/issues", "Bearer installation-1", { title: "title", body: "body" }],
    ["PATCH", "/repos/example-owner/example-repo/issues/12", "Bearer installation-1", { body: "later" }],
  ]);
});

test("each repository's writes use a token scoped to that repository alone", async () => {
  const { api, seen } = fakeApi();
  await api.open("example-owner/example-apps", "title", "body");
  await api.open("example-owner/example-hosts", "title", "body");
  await api.edit("example-owner/example-apps", 12, "later");

  const tokenCalls = seen.filter((s) => s.path.endsWith("/access_tokens"));
  expect(tokenCalls.map((t) => t.body)).toEqual([
    { repositories: ["example-apps"], permissions: { issues: "write" } },
    { repositories: ["example-hosts"], permissions: { issues: "write" } },
  ]);
  const writes = seen.filter((s) => /^\/repos\/[^/]+\/[^/]+\/issues/.test(s.path));
  expect(writes.map((w) => [w.path, w.auth])).toEqual([
    ["/repos/example-owner/example-apps/issues", "Bearer installation-1"],
    ["/repos/example-owner/example-hosts/issues", "Bearer installation-2"],
    ["/repos/example-owner/example-apps/issues/12", "Bearer installation-1"],
  ]);
});

test("a token GitHub rejects is replaced on the next call", async () => {
  const { api, seen, state } = fakeApi();
  let rejected = false;
  state.respond = () => (rejected ? null : ((rejected = true), new Response(null, { status: 401 })));
  await expect(api.open(REPO, "title", "body")).rejects.toThrow();
  await api.open(REPO, "title", "body");
  expect(seen.filter((s) => s.path.endsWith("/access_tokens"))).toHaveLength(2);
});

test("the client finds a recent issue by its marker", async () => {
  const { api } = fakeApi();
  expect(await api.find(REPO, "m-1")).toBe(8);
  expect(await api.find(REPO, "m-2")).toBeNull();
});

test("the client reads whether an issue is closed", async () => {
  const { api, seen, state } = fakeApi();
  state.respond = (path) => (path.endsWith("/issues/3") ? Response.json({ number: 3, state: "closed" }) : Response.json({ number: 4, state: "open" }));
  expect(await api.isClosed(REPO, 3)).toBe(true);
  expect(await api.isClosed(REPO, 4)).toBe(false);
  expect(seen.filter((s) => s.path.includes("/issues/")).map((s) => [s.method, s.path, s.auth])).toEqual([
    ["GET", "/repos/example-owner/example-repo/issues/3", "Bearer installation-1"],
    ["GET", "/repos/example-owner/example-repo/issues/4", "Bearer installation-1"],
  ]);
});

test("GitHub's answers map to refused, gone, or worth a retry", async () => {
  const { api, state } = fakeApi();
  const answer = (status: number, headers: Record<string, string> = {}) => {
    state.respond = () => new Response(null, { status, headers });
  };
  answer(422);
  await expect(api.open(REPO, "t", "b")).rejects.toBeInstanceOf(Refused);
  answer(410);
  await expect(api.edit(REPO, 1, "b")).rejects.toBeInstanceOf(GoneIssue);
  answer(404);
  await expect(api.edit(REPO, 1, "b")).rejects.toBeInstanceOf(GoneIssue);
  for (const [status, headers] of [
    [403, { "x-ratelimit-remaining": "0" }],
    [403, { "retry-after": "60" }],
    [429, {}],
    [502, {}],
  ] as const) {
    answer(status, headers);
    const e = await api.open(REPO, "t", "b").catch((e) => e);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(Refused);
    expect(e).not.toBeInstanceOf(GoneIssue);
  }
});

test("a body stays under GitHub's limit when cleaning lengthens every part, and a token at a cut is still redacted", async () => {
  const { store, queue, issues } = setup();
  const token = `ghp_${"A".repeat(36)}`;
  // A token where each section would be cut, if the cut ran before cleaning.
  const filler = (n: number) => "[a](b) <x ".repeat(4_000).slice(0, n);
  const text = `${filler(14_995)} ${token} ${filler(24_995)} ${token} ${filler(40_000)}`;
  await turn(store, "alert", model(text, summary(text, text)), summaryTool);
  await queue.flush();

  const body = issues[0]!.body;
  expect(body.length).toBeLessThanOrEqual(65_536);
  expect(body).not.toContain("ghp_");
});
