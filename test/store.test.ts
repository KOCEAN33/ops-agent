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
