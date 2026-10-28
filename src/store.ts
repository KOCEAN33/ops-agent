import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { ModelMessage } from "ai";
import type { GroupKey } from "./alert";
import type { Handoff } from "./owner/issues";

export interface Turn {
  id: number;
  sessionId: number;
  text: string;
  // Epoch milliseconds before which the turn does not start.
  nextAt: number;
}

// How a turn ended. A turn without one is pending.
export type TurnEnd = "done" | "budget" | "attempts";

export type Reservation = "ok" | "turn-cap" | "monthly-cap";

// A message waiting for Discord. A post without a session goes to the channel.
export interface Post {
  id: number;
  sessionId: number | null;
  text: string;
  // Messages of the post already sent, so a retry resumes after them.
  sentChunks: number;
}

// A hand-off waiting for GitHub.
export interface IssueWrite {
  id: number;
  sessionId: number;
  handoff: Handoff;
  // An open was sent before, so its issue may exist.
  tried: boolean;
}

export interface StoredMessage {
  id: number;
  message: ModelMessage;
}

export interface Summary {
  throughId: number;
  text: string;
}

export class Store {
  private db: Database;

  constructor(path: string) {
    // A file missing here is one no restore filled. It waits for the spend
    // seed from the first transaction on, so a start cut before the seed runs
    // still seeds on the next one.
    const fresh = path !== ":memory:" && !existsSync(path);
    this.db = new Database(path, { create: true, strict: true });
    // Litestream replicates the WAL, and takes a short write lock while it
    // checkpoints, so a write waits for it instead of failing.
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.transaction(() => {
      // A group holds one open session at a time, and a session closes when
      // its issue does. A file made before sessions could close holds
      // group_key UNIQUE, which SQLite cannot drop in place, so its table is
      // rebuilt.
      const sessions = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
        id INTEGER PRIMARY KEY,
        group_key TEXT NOT NULL,
        firing TEXT NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0
      )`;
      const columns = this.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('sessions')").all();
      if (columns.length > 0 && !columns.some((c) => c.name === "closed")) {
        this.db.run(sessions("sessions_new"));
        this.db.run("INSERT INTO sessions_new (id, group_key, firing) SELECT id, group_key, firing FROM sessions");
        this.db.run("DROP TABLE sessions");
        this.db.run("ALTER TABLE sessions_new RENAME TO sessions");
      }
      this.db.run(sessions("sessions"));
      this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS open_session ON sessions (group_key) WHERE closed = 0");
      this.db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        message TEXT NOT NULL
      )`);
      this.db.run(`CREATE TABLE IF NOT EXISTS spend (
        month TEXT PRIMARY KEY,
        usd REAL NOT NULL
      )`);
      this.db.run(`CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        text TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0,
        spent_usd REAL NOT NULL DEFAULT 0,
        ended TEXT
      )`);
      // The starter message is recorded before its thread opens, so a retry
      // opens the thread on it instead of posting another.
      this.db.run(`CREATE TABLE IF NOT EXISTS threads (
        session_id INTEGER PRIMARY KEY REFERENCES sessions(id),
        starter_id TEXT NOT NULL,
        thread_id TEXT UNIQUE
      )`);
      this.db.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY,
        session_id INTEGER REFERENCES sessions(id),
        text TEXT NOT NULL,
        sent_chunks INTEGER NOT NULL DEFAULT 0,
        state TEXT
      )`);
      this.db.run(`CREATE TABLE IF NOT EXISTS notices (
        key TEXT PRIMARY KEY
      )`);
      // The marker goes into the session's issue, so a retry after a lost
      // response finds the issue instead of opening another. repo, owner/name,
      // is fixed by the session's first write and kept for the session's life.
      this.db.run(`CREATE TABLE IF NOT EXISTS issues (
        session_id INTEGER PRIMARY KEY REFERENCES sessions(id),
        marker TEXT NOT NULL,
        number INTEGER,
        repo TEXT
      )`);
      this.db.run(`CREATE TABLE IF NOT EXISTS issue_writes (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        handoff TEXT NOT NULL,
        tried INTEGER NOT NULL DEFAULT 0,
        state TEXT
      )`);
      // A summary covers the session's messages up to through_id. The messages
      // stay, so a later change of threshold can pick an older summary or none.
      this.db.run(`CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        through_id INTEGER NOT NULL,
        text TEXT NOT NULL
      )`);
      this.db.run("CREATE TABLE IF NOT EXISTS seed_pending (id INTEGER PRIMARY KEY CHECK (id = 1))");
      if (fresh) this.db.run("INSERT OR IGNORE INTO seed_pending (id) VALUES (1)");
    })();
  }

  // Records the group's firing fingerprints and, when they changed, queues a
  // turn with text in the same transaction, so a recorded change is never
  // dropped. Alertmanager repeats a notification every repeat_interval, and a
  // repeat with the same firing alerts is not news worth a model call.
  noteFiring(key: GroupKey, fingerprints: string[], text: string): { sessionId: number; turnId: number | null } {
    const groupKey = JSON.stringify([key.alertname, key.namespace]);
    const firing = JSON.stringify([...fingerprints].sort());
    return this.db.transaction(() => {
      const row = this.db
        .query<{ id: number; firing: string }, [string]>("SELECT id, firing FROM sessions WHERE group_key = ? AND closed = 0")
        .get(groupKey);
      let sessionId: number;
      if (!row) {
        // Alerts still firing when the owner closed the issue are not news
        // either, so only a change opens the group's next session.
        const last = this.db
          .query<{ id: number; firing: string }, [string]>("SELECT id, firing FROM sessions WHERE group_key = ? ORDER BY id DESC LIMIT 1")
          .get(groupKey);
        if (last?.firing === firing) return { sessionId: last.id, turnId: null };
        const { lastInsertRowid } = this.db
          .query("INSERT INTO sessions (group_key, firing) VALUES (?, ?)")
          .run(groupKey, firing);
        sessionId = Number(lastInsertRowid);
        if (fingerprints.length === 0) return { sessionId, turnId: null };
      } else {
        if (row.firing === firing) return { sessionId: row.id, turnId: null };
        this.db.query("UPDATE sessions SET firing = ? WHERE id = ?").run(firing, row.id);
        sessionId = row.id;
      }
      return { sessionId, turnId: this.addTurn(sessionId, text) };
    })();
  }

  addTurn(sessionId: number, text: string): number {
    const { lastInsertRowid } = this.db.query("INSERT INTO turns (session_id, text) VALUES (?, ?)").run(sessionId, text);
    return Number(lastInsertRowid);
  }

  // Every turn not yet ended, oldest first.
  pending(): Turn[] {
    return this.db
      .query<Turn, []>(
        "SELECT id, session_id AS sessionId, text, next_at AS nextAt FROM turns WHERE ended IS NULL ORDER BY id",
      )
      .all();
  }

  // Starts an attempt: counts it and sets when the next one may start, before
  // the turn runs, so an attempt that crashes the process counts too. A turn
  // that has used maxAttempts ends here instead, and claim returns null.
  claim(turnId: number, now: number, retryMs: number, maxAttempts: number): Turn | null {
    return this.db.transaction(() => {
      const row = this.db
        .query<{ attempts: number }, [number]>("SELECT attempts FROM turns WHERE id = ? AND ended IS NULL")
        .get(turnId);
      if (!row) return null;
      if (row.attempts >= maxAttempts) {
        this.db.query("UPDATE turns SET ended = 'attempts' WHERE id = ?").run(turnId);
        this.db
          .query("INSERT INTO posts (session_id, text) SELECT session_id, ? FROM turns WHERE id = ?")
          .run(`This alert's turn failed ${maxAttempts} times and was dropped. The agent's log holds the errors.`, turnId);
        return null;
      }
      // After the last attempt fails, the next claim only ends the turn, so it
      // need not wait, and the turns behind it start sooner.
      const nextAt = row.attempts + 1 >= maxAttempts ? now : now + retryMs;
      return this.db
        .query<Turn, [number, number]>(
          `UPDATE turns SET attempts = attempts + 1, next_at = ? WHERE id = ?
           RETURNING id, session_id AS sessionId, text, next_at AS nextAt`,
        )
        .get(nextAt, turnId);
    })();
  }

  // Returns an attempt that never reached a model, such as one refused by the
  // monthly cap, and sets when the turn tries again.
  defer(turnId: number, nextAt: number) {
    this.db.query("UPDATE turns SET attempts = attempts - 1, next_at = ? WHERE id = ?").run(nextAt, turnId);
  }

  // Appends the turn's messages, queues its post to the owner and its hand-off
  // to the issue, and ends it in one transaction, so a turn either ran and left
  // all three or stays pending and runs again.
  endTurn(turnId: number, end: TurnEnd, messages: ModelMessage[], post: string, handoff?: Handoff) {
    const insert = this.db.query("INSERT INTO messages (session_id, message) SELECT session_id, ? FROM turns WHERE id = ?");
    this.db.transaction(() => {
      for (const m of messages) insert.run(JSON.stringify(m), turnId);
      this.db.query("INSERT INTO posts (session_id, text) SELECT session_id, ? FROM turns WHERE id = ?").run(post, turnId);
      if (handoff) {
        this.db
          .query("INSERT OR IGNORE INTO issues (session_id, marker) SELECT session_id, ? FROM turns WHERE id = ?")
          .run(crypto.randomUUID(), turnId);
        this.db
          .query("INSERT INTO issue_writes (session_id, handoff) SELECT session_id, ? FROM turns WHERE id = ?")
          .run(JSON.stringify(handoff), turnId);
      }
      this.db.query("UPDATE turns SET ended = ? WHERE id = ?").run(end, turnId);
    })();
  }

  // Queues a channel post the first time key is seen.
  noticeOnce(key: string, text: string) {
    this.db.transaction(() => {
      if (this.db.query("INSERT OR IGNORE INTO notices (key) VALUES (?)").run(key).changes === 0) return;
      this.db.query("INSERT INTO posts (session_id, text) VALUES (NULL, ?)").run(text);
    })();
  }

  // The oldest post not yet sent or dropped.
  nextPost(): Post | null {
    return this.db
      .query<Post, []>(
        "SELECT id, session_id AS sessionId, text, sent_chunks AS sentChunks FROM posts WHERE state IS NULL ORDER BY id LIMIT 1",
      )
      .get();
  }

  postProgress(postId: number, sentChunks: number) {
    this.db.query("UPDATE posts SET sent_chunks = ? WHERE id = ?").run(sentChunks, postId);
  }

  postSent(postId: number) {
    this.db.query("UPDATE posts SET state = 'sent' WHERE id = ?").run(postId);
  }

  // A post Discord refused would otherwise hold back every post after it.
  postDropped(postId: number) {
    this.db.query("UPDATE posts SET state = 'dropped' WHERE id = ?").run(postId);
  }

  // The oldest hand-off not yet written or dropped.
  nextIssueWrite(): IssueWrite | null {
    const row = this.db
      .query<{ id: number; sessionId: number; handoff: string; tried: number }, []>(
        "SELECT id, session_id AS sessionId, handoff, tried FROM issue_writes WHERE state IS NULL ORDER BY id LIMIT 1",
      )
      .get();
    return row && { ...row, handoff: JSON.parse(row.handoff), tried: row.tried === 1 };
  }

  issueWriteTried(writeId: number) {
    this.db.query("UPDATE issue_writes SET tried = 1 WHERE id = ?").run(writeId);
  }

  issueWriteEnded(writeId: number, state: "sent" | "dropped") {
    this.db.query("UPDATE issue_writes SET state = ? WHERE id = ?").run(state, writeId);
  }

  // Whether the session has queued a hand-off, so its issue is open or opening.
  hasIssue(sessionId: number): boolean {
    return this.db.query("SELECT 1 FROM issues WHERE session_id = ?").get(sessionId) !== null;
  }

  // Exists for every session with a queued write. repo is null until the
  // session's first write.
  issue(sessionId: number): { marker: string; number: number | null; repo: string | null } {
    return this.db
      .query<{ marker: string; number: number | null; repo: string | null }, [number]>("SELECT marker, number, repo FROM issues WHERE session_id = ?")
      .get(sessionId)!;
  }

  // Sets the session's issue repository once and returns the one that holds.
  fixIssueRepo(sessionId: number, repo: string): string {
    this.db.query("UPDATE issues SET repo = ? WHERE session_id = ? AND repo IS NULL").run(repo, sessionId);
    return this.issue(sessionId).repo!;
  }

  setIssue(sessionId: number, number: number) {
    this.db.query("UPDATE issues SET number = ? WHERE session_id = ?").run(number, sessionId);
  }

  // The issue is gone, so the next write opens a new one on the same
  // repository.
  forgetIssue(sessionId: number) {
    this.db.query("UPDATE issues SET number = NULL WHERE session_id = ?").run(sessionId);
  }

  // Every open session's issue that GitHub numbered.
  openIssues(): { sessionId: number; repo: string; number: number }[] {
    return this.db
      .query<{ sessionId: number; repo: string; number: number }, []>(
        `SELECT s.id AS sessionId, i.repo, i.number FROM sessions s JOIN issues i ON i.session_id = s.id
         WHERE s.closed = 0 AND i.number IS NOT NULL AND i.repo IS NOT NULL`,
      )
      .all();
  }

  // The issue of the group's latest session before this one, as owner/name#number.
  earlierIssue(sessionId: number): string | null {
    const row = this.db
      .query<{ repo: string; number: number }, [number, number]>(
        `SELECT i.repo, i.number FROM sessions s JOIN issues i ON i.session_id = s.id
         WHERE s.group_key = (SELECT group_key FROM sessions WHERE id = ?) AND s.id < ? AND i.number IS NOT NULL
         ORDER BY s.id DESC LIMIT 1`,
      )
      .get(sessionId, sessionId);
    return row && `${row.repo}#${row.number}`;
  }

  // Ends the session once it has no turn or hand-off pending, so the last
  // hand-off reaches the issue first, and tells the thread. Returns whether it
  // closed.
  closeSession(sessionId: number): boolean {
    return this.db.transaction(() => {
      const { changes } = this.db
        .query(
          `UPDATE sessions SET closed = 1 WHERE id = ? AND closed = 0
           AND NOT EXISTS (SELECT 1 FROM turns WHERE session_id = sessions.id AND ended IS NULL)
           AND NOT EXISTS (SELECT 1 FROM issue_writes WHERE session_id = sessions.id AND state IS NULL)`,
        )
        .run(sessionId);
      if (changes === 0) return false;
      this.queuePost(sessionId, "이슈가 닫혀 이 세션을 종료합니다. 같은 알림 그룹의 다음 알림은 새 스레드와 새 이슈로 시작합니다.");
      return true;
    })();
  }

  isClosed(sessionId: number): boolean {
    return this.db.query<{ c: number }, [number]>("SELECT closed AS c FROM sessions WHERE id = ?").get(sessionId)?.c === 1;
  }

  queuePost(sessionId: number, text: string) {
    this.db.query("INSERT INTO posts (session_id, text) VALUES (?, ?)").run(sessionId, text);
  }

  // The session's alert group, which names its thread.
  groupKey(sessionId: number): GroupKey {
    const row = this.db.query<{ k: string }, [number]>("SELECT group_key AS k FROM sessions WHERE id = ?").get(sessionId);
    const [alertname, namespace] = JSON.parse(row!.k);
    return { alertname, namespace };
  }

  // The title of the session's latest hand-off that holds one.
  title(sessionId: number): string | null {
    return (
      this.db
        .query<{ t: string }, [number]>(
          "SELECT json_extract(handoff, '$.title') AS t FROM issue_writes WHERE session_id = ? AND t IS NOT NULL ORDER BY id DESC LIMIT 1",
        )
        .get(sessionId)?.t ?? null
    );
  }

  // How many alerts in the session's group fired at its last notification.
  firingCount(sessionId: number): number {
    const row = this.db.query<{ f: string }, [number]>("SELECT firing AS f FROM sessions WHERE id = ?").get(sessionId);
    return JSON.parse(row!.f).length;
  }

  thread(sessionId: number): { starterId: string; threadId: string | null } | null {
    return this.db
      .query<{ starterId: string; threadId: string | null }, [number]>(
        "SELECT starter_id AS starterId, thread_id AS threadId FROM threads WHERE session_id = ?",
      )
      .get(sessionId);
  }

  setStarter(sessionId: number, starterId: string) {
    this.db.query("INSERT INTO threads (session_id, starter_id) VALUES (?, ?)").run(sessionId, starterId);
  }

  setThread(sessionId: number, threadId: string) {
    this.db.query("UPDATE threads SET thread_id = ? WHERE session_id = ?").run(threadId, sessionId);
  }

  // The thread or its starter is gone, so the next post starts both again.
  forgetThread(sessionId: number) {
    this.db.query("DELETE FROM threads WHERE session_id = ?").run(sessionId);
  }

  sessionForThread(threadId: string): number | null {
    return (
      this.db.query<{ s: number }, [string]>("SELECT session_id AS s FROM threads WHERE thread_id = ?").get(threadId)?.s ??
      null
    );
  }

  messages(sessionId: number): StoredMessage[] {
    return this.db
      .query<{ id: number; message: string }, [number]>("SELECT id, message FROM messages WHERE session_id = ? ORDER BY id")
      .all(sessionId)
      .map((r) => ({ id: r.id, message: JSON.parse(r.message) }));
  }

  // Oldest first.
  summaries(sessionId: number): Summary[] {
    return this.db
      .query<Summary, [number]>("SELECT through_id AS throughId, text FROM summaries WHERE session_id = ? ORDER BY through_id")
      .all(sessionId);
  }

  addSummary(sessionId: number, throughId: number, text: string) {
    this.db.query("INSERT INTO summaries (session_id, through_id, text) VALUES (?, ?, ?)").run(sessionId, throughId, text);
  }

  monthSpend(month: string): number {
    return this.db.query<{ usd: number }, [string]>("SELECT usd FROM spend WHERE month = ?").get(month)?.usd ?? 0;
  }

  // Carried across the turn's attempts, so retries share one per-turn cap.
  turnSpend(turnId: number): number {
    return this.db.query<{ usd: number }, [number]>("SELECT spent_usd AS usd FROM turns WHERE id = ?").get(turnId)?.usd ?? 0;
  }

  // Adds usd to the turn's and the month's spend only if both stay within their
  // caps. A caller reserves a call's worst case here before making it and
  // settles the difference afterwards, so concurrent turns cannot all pass the
  // same reading of the spend, and a call cut by a crash stays charged.
  reserve(month: string, turnId: number, usd: number, turnCap: number, monthlyCap: number): Reservation {
    return this.db.transaction((): Reservation => {
      if (this.turnSpend(turnId) + usd > turnCap) return "turn-cap";
      if (this.monthSpend(month) + usd > monthlyCap) return "monthly-cap";
      this.settle(month, turnId, usd);
      return "ok";
    })();
  }

  settle(month: string, turnId: number, usd: number) {
    this.db.transaction(() => {
      this.addSpend(month, usd);
      this.db.query("UPDATE turns SET spent_usd = spent_usd + ? WHERE id = ?").run(usd, turnId);
    })();
  }

  addSpend(month: string, usd: number) {
    this.db
      .query("INSERT INTO spend (month, usd) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET usd = usd + excluded.usd")
      .run(month, usd);
  }

  seedPending(): boolean {
    return this.db.query("SELECT 1 FROM seed_pending").get() !== null;
  }

  // Ends the wait for the spend seed with the month's spend read back.
  seeded(month: string, usd: number) {
    this.db.transaction(() => {
      this.addSpend(month, usd);
      this.db.run("DELETE FROM seed_pending");
    })();
  }

  // Ends the wait for the spend seed with a notice to the owner instead.
  seedFailed(key: string, text: string) {
    this.db.transaction(() => {
      this.noticeOnce(key, text);
      this.db.run("DELETE FROM seed_pending");
    })();
  }
}
