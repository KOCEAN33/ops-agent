import { Database } from "bun:sqlite";
import type { ModelMessage } from "ai";
import type { GroupKey } from "./alert";

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

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      group_key TEXT NOT NULL UNIQUE,
      firing TEXT NOT NULL
    )`);
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
        .query<{ id: number; firing: string }, [string]>("SELECT id, firing FROM sessions WHERE group_key = ?")
        .get(groupKey);
      let sessionId: number;
      if (!row) {
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
      const { lastInsertRowid } = this.db
        .query("INSERT INTO turns (session_id, text) VALUES (?, ?)")
        .run(sessionId, text);
      return { sessionId, turnId: Number(lastInsertRowid) };
    })();
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

  // Appends the turn's messages and ends it in one transaction, so a turn
  // either ran and left its messages or stays pending and runs again.
  endTurn(turnId: number, end: TurnEnd, messages: ModelMessage[]) {
    const insert = this.db.query("INSERT INTO messages (session_id, message) SELECT session_id, ? FROM turns WHERE id = ?");
    this.db.transaction(() => {
      for (const m of messages) insert.run(JSON.stringify(m), turnId);
      this.db.query("UPDATE turns SET ended = ? WHERE id = ?").run(end, turnId);
    })();
  }

  messages(sessionId: number): ModelMessage[] {
    return this.db
      .query<{ message: string }, [number]>("SELECT message FROM messages WHERE session_id = ? ORDER BY id")
      .all(sessionId)
      .map((r) => JSON.parse(r.message));
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
}
