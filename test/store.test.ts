import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";

test("the store's file is in WAL mode, which Litestream replicates", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ops-agent-store-")), "agent.sqlite");
  new Store(path);
  // WAL is a property of the file, so a second connection reads it.
  expect(new Database(path).query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
});

const key = { alertname: "KubeJobFailed", namespace: "example-app" };

test("a file made before sessions could close keeps its sessions, and a closed one gives way to a new session", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ops-agent-store-")), "agent.sqlite");
  const old = new Database(path);
  old.run("CREATE TABLE sessions (id INTEGER PRIMARY KEY, group_key TEXT NOT NULL UNIQUE, firing TEXT NOT NULL)");
  old.run("CREATE TABLE threads (session_id INTEGER PRIMARY KEY REFERENCES sessions(id), starter_id TEXT NOT NULL, thread_id TEXT UNIQUE)");
  old.run(`INSERT INTO sessions (id, group_key, firing) VALUES (5, '["KubeJobFailed","example-app"]', '["a"]')`);
  old.run("INSERT INTO threads (session_id, starter_id, thread_id) VALUES (5, 'starter-1', 'thread-1')");
  old.close();

  const store = new Store(path);
  expect(store.noteFiring(key, ["a"], "repeat")).toEqual({ sessionId: 5, turnId: null });
  expect(store.sessionForThread("thread-1")).toBe(5);
  store.closeSession(5);
  const next = store.noteFiring(key, ["b"], "alert");
  expect(next.sessionId).not.toBe(5);
  expect(next.turnId).not.toBeNull();
  expect(store.groupKey(next.sessionId)).toEqual(key);

  // A second open finds the file already migrated.
  expect(new Store(path).noteFiring(key, ["b"], "repeat")).toEqual({ sessionId: next.sessionId, turnId: null });
});

test("a repeat of the alerts still firing when the session closed starts nothing, and a change opens a new session", () => {
  const store = new Store(":memory:");
  const first = store.noteFiring(key, ["a"], "alert");
  store.endTurn(first.turnId!, "done", [], "answer");
  store.closeSession(first.sessionId);

  expect(store.noteFiring(key, ["a"], "repeat").turnId).toBeNull();
  expect(store.pending()).toHaveLength(0);

  const next = store.noteFiring(key, ["a", "b"], "alert");
  expect(next.sessionId).not.toBe(first.sessionId);
  expect(next.turnId).not.toBeNull();
});
