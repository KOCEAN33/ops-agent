import { Database } from "bun:sqlite";
import type { ModelMessage } from "ai";
import type { GroupKey } from "./alert";

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
  }

  // Records the group's firing fingerprints and reports whether they changed.
  // Alertmanager repeats a notification every repeat_interval, and a repeat
  // with the same firing alerts is not news worth a model call.
  noteFiring(key: GroupKey, fingerprints: string[]): { sessionId: number; changed: boolean } {
    const groupKey = JSON.stringify([key.alertname, key.namespace]);
    const firing = JSON.stringify([...fingerprints].sort());
    return this.db.transaction(() => {
      const row = this.db
        .query<{ id: number; firing: string }, [string]>("SELECT id, firing FROM sessions WHERE group_key = ?")
        .get(groupKey);
      if (!row) {
        const { lastInsertRowid } = this.db
          .query("INSERT INTO sessions (group_key, firing) VALUES (?, ?)")
          .run(groupKey, firing);
        return { sessionId: Number(lastInsertRowid), changed: fingerprints.length > 0 };
      }
      if (row.firing === firing) return { sessionId: row.id, changed: false };
      this.db.query("UPDATE sessions SET firing = ? WHERE id = ?").run(firing, row.id);
      return { sessionId: row.id, changed: true };
    })();
  }

  messages(sessionId: number): ModelMessage[] {
    return this.db
      .query<{ message: string }, [number]>("SELECT message FROM messages WHERE session_id = ? ORDER BY id")
      .all(sessionId)
      .map((r) => JSON.parse(r.message));
  }

  append(sessionId: number, messages: ModelMessage[]) {
    const insert = this.db.query("INSERT INTO messages (session_id, message) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const m of messages) insert.run(sessionId, JSON.stringify(m));
    })();
  }

  monthSpend(month: string): number {
    return this.db.query<{ usd: number }, [string]>("SELECT usd FROM spend WHERE month = ?").get(month)?.usd ?? 0;
  }

  addSpend(month: string, usd: number) {
    this.db
      .query("INSERT INTO spend (month, usd) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET usd = usd + excluded.usd")
      .run(month, usd);
  }
}
