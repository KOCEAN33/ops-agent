import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnQueue, type QueueDeps } from "../src/queue";
import { createHandler } from "../src/server";
import { Store, type Turn } from "../src/store";

// A file, not :memory:, so a second Store on it stands for the process after a
// restart.
const dbFile = () => join(mkdtempSync(join(tmpdir(), "ops-agent-")), "db.sqlite");

async function until(cond: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(2);
  }
}

let fingerprint = 0;
function notify(store: Store, alertname: string, text: string): number {
  return store.noteFiring({ alertname, namespace: "example-app" }, [String(fingerprint++)], text).turnId!;
}

function queue(store: Store, run: QueueDeps["run"], over: Partial<QueueDeps> = {}) {
  const q = new TurnQueue({ store, run, now: () => new Date(), limit: 4, retryMs: 5, maxAttempts: 3, ...over });
  q.kick();
  return q;
}

// Ends the turn as runTurn does when it answers.
const answer = (store: Store, t: Turn) => {
  store.endTurn(t.id, "done", []);
  return { text: "ok" };
};

const never = () => new Promise<never>(() => {});

test("a turn that fails runs again", async () => {
  const store = new Store(":memory:");
  const id = notify(store, "A", "alert");
  const calls: number[] = [];
  queue(store, async (t) => {
    calls.push(t.id);
    if (calls.length === 1) throw new Error("model unavailable");
    return answer(store, t);
  });

  await until(() => store.pending().length === 0);
  expect(calls).toEqual([id, id]);
});

test("a turn cut by a restart runs again", async () => {
  const file = dbFile();
  const before = new Store(file);
  notify(before, "A", "alert");
  let started = 0;
  queue(before, async () => {
    started++;
    return never();
  });
  await until(() => started === 1);

  const after = new Store(file);
  const calls: string[] = [];
  queue(after, async (t) => {
    calls.push(t.text);
    return answer(after, t);
  });
  await until(() => after.pending().length === 0);
  expect(calls).toEqual(["alert"]);
});

test("a notification recorded before a crash still gets its turn", async () => {
  const file = dbFile();
  const handle = createHandler({ store: new Store(file), token: "t", kick: () => {} });
  const body = await Bun.file(`${import.meta.dir}/payloads/kube-job-failed.json`).text();
  const res = await handle(
    new Request("http://localhost/alertmanager", { method: "POST", body, headers: { authorization: "Bearer t" } }),
  );
  expect(res.status).toBe(202);

  const after = new Store(file);
  const calls: string[] = [];
  queue(after, async (t) => {
    calls.push(t.text);
    return answer(after, t);
  });
  await until(() => calls.length === 1);
  expect(calls[0]).toContain("Job example-app/example-app-29870000 failed to complete.");
});

test("the attempt limit ends a turn that keeps failing, and the next turn on its session then runs", async () => {
  const store = new Store(":memory:");
  const bad = notify(store, "A", "bad");
  const next = notify(store, "A", "next");
  const calls: number[] = [];
  queue(store, async (t) => {
    calls.push(t.id);
    if (t.id === bad) throw new Error("model unavailable");
    return answer(store, t);
  });

  await until(() => store.pending().length === 0);
  expect(calls).toEqual([bad, bad, bad, next]);
});

test("a turn that crashes the process on every attempt ends at the attempt limit", async () => {
  const file = dbFile();
  notify(new Store(file), "A", "alert");
  for (let i = 0; i < 3; i++) {
    let started = false;
    queue(new Store(file), async () => {
      started = true;
      return never();
    });
    await until(() => started);
  }

  const after = new Store(file);
  let runs = 0;
  queue(after, async (t) => {
    runs++;
    return answer(after, t);
  });
  await until(() => after.pending().length === 0);
  expect(runs).toBe(0);
});

test("a turn refused by the monthly cap spends no attempt", async () => {
  const store = new Store(":memory:");
  notify(store, "A", "alert");
  let runs = 0;
  queue(store, async (t) => {
    if (++runs <= 3) return { skipped: "monthly-cap" as const };
    return answer(store, t);
  });

  await until(() => store.pending().length === 0);
  expect(runs).toBe(4);
});

// A run that waits until the test releases it, recording which turns run now.
function gated(store: Store) {
  const running = new Set<string>();
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const run = async (t: Turn) => {
    running.add(t.text);
    started.push(t.text);
    await new Promise<void>((r) => gates.set(t.text, r));
    running.delete(t.text);
    return answer(store, t);
  };
  return { run, running, started, release: (text: string) => gates.get(text)!() };
}

test("turns on one session run one at a time in order, beside turns on another session", async () => {
  const store = new Store(":memory:");
  notify(store, "A", "a1");
  notify(store, "A", "a2");
  notify(store, "B", "b1");
  const g = gated(store);
  queue(store, g.run);

  await until(() => g.running.size === 2);
  await Bun.sleep(20);
  expect([...g.running].sort()).toEqual(["a1", "b1"]);

  g.release("a1");
  await until(() => g.running.has("a2"));
  expect(g.started).toEqual(["a1", "b1", "a2"]);
});

test("no more turns run at once than the limit", async () => {
  const store = new Store(":memory:");
  for (const name of ["A", "B", "C"]) notify(store, name, name);
  const g = gated(store);
  queue(store, g.run, { limit: 2 });

  await until(() => g.running.size === 2);
  await Bun.sleep(20);
  expect(g.running.size).toBe(2);

  g.release(g.started[0]!);
  await until(() => g.started.length === 3);
  expect(g.running.size).toBe(2);
});
