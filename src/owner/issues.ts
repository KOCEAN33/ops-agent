import type { ModelMessage } from "ai";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { clean } from "./links";
import type { GroupKey } from "../alert";
import type { IssueWrite, Store } from "../store";
import { readTool, unwrap, type ReadTool } from "../tools/contract";

// What one turn hands off to the owner's issue. The store keeps it raw, and the
// queue cleans it when it writes, as the outbox does for posts.
export interface Handoff {
  // Names the alert group's Discord thread when it opens.
  title?: string;
  symptom: string;
  cause: string;
  // The repository name, without its owner, the model last recorded in the
  // turn. The queue checks it against the configured list.
  repo?: string;
}

const ISSUE_REPOSITORY = "issue_repository";
const ISSUE_SUMMARY = "issue_summary";

// Only records the name. Code writes the issue, so injected text that steers
// this call can at most move the issue to another listed repository.
export function issueRepositoryTool(names: [string, ...string[]]): Record<string, ReadTool> {
  return {
    [ISSUE_REPOSITORY]: readTool({
      description: `Record the GitOps repository that holds the root cause, so this alert group's issue opens there. The repositories: ${names.join(", ")}. Without a call, the issue opens on ${names[0]}.`,
      input: z.object({ repo: z.enum(names) }),
      run: async () => ({ recorded: true }),
    }),
  };
}

// Only records the sections. Code writes them into the issue whether or not
// the model calls this, so injected text cannot hold back the hand-off.
export function issueSummaryTool(): Record<string, ReadTool> {
  return {
    [ISSUE_SUMMARY]: readTool({
      description:
        "Record this alert group's issue: a title, the symptom and the cause as you understand them now. Each call replaces the whole issue body, so state everything the owner needs to fix the root cause. Call it once per turn, before your answer.",
      input: z.object({
        title: z.string().describe("The problem behind the alert in a few words, such as which workload fails and how. It names the alert's Discord thread, so the owner can tell threads apart later."),
        symptom: z.string().describe("What fired and what the owner would see, in markdown."),
        cause: z.string().describe("The root cause you found, the evidence for it, and where its fix belongs, in markdown."),
      }),
      run: async () => ({ recorded: true }),
    }),
  };
}

// The input of the last call to a record tool that recorded it. The tool
// contract answers a repeated identical call with an error instead of running
// it, and that call still counts as the last.
function lastRecorded(messages: ModelMessage[], toolName: string): unknown {
  const recorded = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const p of m.content) {
      // A call the schema refused returns an error, not a record.
      if (p.type === "tool-result" && p.output.type === "text" && (unwrap(p.output.value) as { recorded?: unknown } | undefined)?.recorded === true) {
        recorded.add(p.toolCallId);
      }
    }
  }
  const byInput = new Map<string, unknown>();
  let last: unknown;
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p.type !== "tool-call" || p.toolName !== toolName) continue;
      const key = JSON.stringify(p.input);
      if (recorded.has(p.toolCallId)) byInput.set(key, p.input);
      last = byInput.get(key) ?? last;
    }
  }
  return last;
}

export function fallbackSymptom(group: GroupKey, firing: number): string {
  const where = group.namespace === null ? ", cluster-wide" : ` in ${group.namespace}`;
  return `${group.alertname}${where}, ${firing} ${firing === 1 ? "alert" : "alerts"} firing.`;
}

// A turn with no recorded summary still hands off, from facts code holds. With
// neither a summary nor an answer it has nothing to hand off, and null says so.
export function handoff(messages: ModelMessage[], answer: string | null, group: GroupKey, firing: number): Handoff | null {
  const s = lastRecorded(messages, ISSUE_SUMMARY) as { title: string; symptom: string; cause: string } | undefined;
  if (s === undefined && answer === null) return null;
  const repo = (lastRecorded(messages, ISSUE_REPOSITORY) as { repo: string } | undefined)?.repo;
  return {
    ...(s === undefined ? {} : { title: s.title }),
    symptom: s?.symptom ?? fallbackSymptom(group, firing),
    cause: s?.cause ?? answer!,
    ...(repo === undefined ? {} : { repo }),
  };
}

// GitHub refuses a body over 65,536 characters.
const MAX_SYMPTOM = 15_000;
const MAX_CAUSE = 40_000;
const MAX_TITLE = 200;

// The stopgap tools do not exist yet. Once they do, this section comes from
// the Write record, so the model never claims an action that did not run.
const NO_ACTIONS = "No stopgap taken.";

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n[cut ${s.length - max} more characters]` : s);

const allowed = (host: string, hosts: ReadonlySet<string>) => hosts.has(host.toLowerCase());

// Strips the links GitHub would form without a scheme: `www.` autolinks and
// protocol-relative targets.
function stripBare(text: string, hosts: ReadonlySet<string>): string {
  return text.replace(/(^|[\s("'=<*_~])((?:www\.|\/\/)[^\s<>()"']+)/gi, (all, lead: string, link: string) => {
    const host = link.replace(/^\/\//, "").split(/[/?#:]/)[0]!;
    return allowed(host, hosts) ? all : `${lead}[link removed]`;
  });
}

// Model text can carry injected alert or log text. GitHub's image proxy
// fetches any image in a body, and an agent given the issue may fetch a link,
// so links off the allowlist go, and markdown or HTML that could form a link or
// image from what is left is broken with character references: `](` opens an
// inline link or image, `]:` a link definition, and `<` a tag or autolink.
// Headings are broken too, so model text cannot fake the Actions section that
// code writes: `#` opens one, and a line of `=` or `-` underlines the line above.
// References need no backslash, so a backslash in the text cannot undo them.
function cleanMarkdown(text: string, hosts: ReadonlySet<string>): string {
  return stripBare(clean(text, hosts), hosts)
    .replaceAll("](", "]&#40;")
    .replaceAll("]:", "]&#58;")
    .replace(/<(?=[a-z/!?])/gi, "&lt;")
    .replace(/^( {0,3})#/gm, "$1&#35;")
    .replace(/^( {0,3})([=-])(?=\2* *$)/gm, (_, lead: string, c: string) => `${lead}${c === "=" ? "&#61;" : "&#45;"}`);
}

const markerLine = (marker: string) => `<!-- ops-agent:${marker} -->`;

export function issueBody(h: Handoff, hosts: ReadonlySet<string>, marker: string): string {
  // Cleaning runs on the whole text and the cut after it: cleaning lengthens
  // text, and a token cut in half no longer matches its redaction pattern.
  return [
    `### Symptom\n\n${cut(cleanMarkdown(h.symptom, hosts), MAX_SYMPTOM)}`,
    `### Cause\n\n${cut(cleanMarkdown(h.cause, hosts), MAX_CAUSE)}`,
    `### Actions\n\n${NO_ACTIONS}`,
    markerLine(marker),
  ].join("\n\n");
}

// Each call takes the repository as owner/name.
export interface IssueApi {
  // Returns the issue's number.
  open(repo: string, title: string, body: string): Promise<number>;
  // Replaces the issue's body. GitHub keeps the old one in the edit history.
  edit(repo: string, issue: number, body: string): Promise<void>;
  // The number of a recent issue whose body holds the marker.
  find(repo: string, marker: string): Promise<number | null>;
}

// GitHub refused the write for good, so sending it again changes nothing.
export class Refused extends Error {}

// The issue is gone, such as one the owner deleted.
export class GoneIssue extends Error {}

export interface IssueQueueDeps {
  store: Store;
  api: IssueApi;
  linkHosts: ReadonlySet<string>;
  // owner/name of each GitOps repository, the first being the default.
  repos: readonly string[];
}

// Writes the store's hand-offs in order: a session's first opens its issue and
// later ones replace its body. A write stays queued until GitHub takes or
// refuses it, so an outage delays hand-offs and loses none. An edit whose
// response is lost is written again on the retry, which changes nothing.
export class IssueQueue {
  private busy = false;

  constructor(private d: IssueQueueDeps) {}

  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let w = this.d.store.nextIssueWrite(); w; w = this.d.store.nextIssueWrite()) {
        try {
          await this.deliver(w);
          this.d.store.issueWriteEnded(w.id, "sent");
        } catch (e) {
          console.error(JSON.stringify({ msg: "issue write failed", writeId: w.id, error: String(e) }));
          // The next pass opens a new issue for the same write.
          if (e instanceof GoneIssue) this.d.store.forgetIssue(w.sessionId);
          else if (e instanceof Refused) this.d.store.issueWriteEnded(w.id, "dropped");
          // The next flush tries again, so writes keep their order.
          else return;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  // The session's first write fixes its repository: the one the hand-off
  // names if it is listed, else the default. Later names are ignored, so the
  // issue stays where it opened.
  private repo(w: IssueWrite): string {
    const named = this.d.repos.find((r) => r.split("/")[1] === w.handoff.repo);
    return this.d.store.fixIssueRepo(w.sessionId, named ?? this.d.repos[0]!);
  }

  // A hand-off queued before the issue held sections carries the answer alone.
  // Without this it would throw on every flush and hold back every write after it.
  private current(w: IssueWrite): Handoff {
    const h = w.handoff as Partial<Handoff> & { answer?: string };
    if (typeof h.symptom === "string") return w.handoff;
    return {
      symptom: fallbackSymptom(this.d.store.groupKey(w.sessionId), this.d.store.firingCount(w.sessionId)),
      cause: h.answer ?? "",
      ...(h.repo === undefined ? {} : { repo: h.repo }),
    };
  }

  private async deliver(w: IssueWrite) {
    const issue = this.d.store.issue(w.sessionId);
    const repo = this.repo(w);
    const body = issueBody(this.current(w), this.d.linkHosts, issue.marker);
    if (issue.number !== null) return this.d.api.edit(repo, issue.number, body);
    // An earlier open may have run and lost its response. Its issue carries
    // the session's marker.
    if (w.tried) {
      const found = await this.d.api.find(repo, issue.marker);
      if (found !== null) return this.d.store.setIssue(w.sessionId, found);
    }
    this.d.store.issueWriteTried(w.id);
    const { alertname, namespace } = this.d.store.groupKey(w.sessionId);
    // GitHub renders no link or image in a title.
    const title = stripBare(clean(`${alertname} / ${namespace ?? "cluster"}`, this.d.linkHosts), this.d.linkHosts).replace(/\s+/g, " ").slice(0, MAX_TITLE);
    this.d.store.setIssue(w.sessionId, await this.d.api.open(repo, title, body));
  }
}

export interface GitHubDeps {
  apiUrl: string;
  appId: string;
  // The App's private key, PEM. GitHub issues PKCS#1, which WebCrypto cannot
  // import.
  key: string;
  now: () => Date;
}

const TIMEOUT_MS = 20_000;
// A token is replaced this long before GitHub says it expires.
const TOKEN_MARGIN_MS = 5 * 60_000;
// A lost response is retried within a minute, so the issue is among the newest.
const FIND_RECENT = 30;

// Talks to GitHub as the App. Each installation token is scoped down to issues
// write on the one repository it writes to, whatever else the App holds.
export function githubApi(d: GitHubDeps): IssueApi {
  const key: KeyObject = createPrivateKey(d.key);
  // Keyed by owner/name.
  const installations = new Map<string, number>();
  const tokens = new Map<string, { value: string; expiresAt: number }>();

  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  // GitHub allows at most 10 minutes, and backdating covers clock drift.
  const jwt = () => {
    const iat = Math.floor(d.now().getTime() / 1000) - 60;
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 540, iss: d.appId })}`;
    return `${unsigned}.${sign("sha256", Buffer.from(unsigned), key).toString("base64url")}`;
  };

  const request = (method: string, path: string, auth: string, body?: unknown) =>
    fetch(`${d.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${auth}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ops-agent",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  // A failure here is the App's configuration or an outage, retried either way.
  const appCall = async (method: string, path: string, body?: unknown) => {
    const res = await request(method, path, jwt(), body);
    if (!res.ok) throw new Error(`GitHub ${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return res.json();
  };

  const installationToken = async (repo: string) => {
    const cached = tokens.get(repo);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > d.now().getTime()) return cached.value;
    let installation = installations.get(repo);
    if (installation === undefined) {
      installation = ((await appCall("GET", `/repos/${repo}/installation`)) as { id: number }).id;
      installations.set(repo, installation);
    }
    const t = (await appCall("POST", `/app/installations/${installation}/access_tokens`, {
      repositories: [repo.split("/")[1]!],
      permissions: { issues: "write" },
    })) as { token: string; expires_at: string };
    tokens.set(repo, { value: t.token, expiresAt: Date.parse(t.expires_at) });
    return t.token;
  };

  const call = async (repo: string, method: string, path: string, body: unknown, onIssue: boolean) => {
    const res = await request(method, `/repos/${repo}${path}`, await installationToken(repo), body);
    if (res.ok) return res.json();
    const text = `GitHub ${method} /repos/${repo}${path} answered ${res.status}: ${(await res.text()).slice(0, 500)}`;
    if (res.status === 401) tokens.delete(repo);
    // GitHub answers a rate limit with 403 as well as 429.
    const limited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
    if (res.status === 401 || limited || res.status >= 500) throw new Error(text);
    if (onIssue && (res.status === 404 || res.status === 410)) throw new GoneIssue(text);
    throw new Refused(text);
  };

  return {
    open: async (repo, title, body) => ((await call(repo, "POST", "/issues", { title, body }, false)) as { number: number }).number,
    edit: async (repo, issue, body) => {
      await call(repo, "PATCH", `/issues/${issue}`, { body }, true);
    },
    find: async (repo, marker) => {
      const path = `/issues?state=all&sort=created&direction=desc&per_page=${FIND_RECENT}`;
      const issues = (await call(repo, "GET", path, undefined, false)) as { number: number; body: string | null }[];
      return issues.find((i) => i.body?.includes(markerLine(marker)))?.number ?? null;
    },
  };
}
