import { expect, test } from "bun:test";
import { createHandler } from "../src/server";
import { Store } from "../src/store";

function setup() {
  const turns: { sessionId: number; text: string }[] = [];
  const handle = createHandler({
    store: new Store(":memory:"),
    startTurn: (sessionId, text) => void turns.push({ sessionId, text }),
  });
  const post = (path: string, body: string) =>
    handle(new Request(`http://localhost${path}`, { method: "POST", body }));
  return { turns, post };
}

const payload = (name: string) => Bun.file(`${import.meta.dir}/payloads/${name}.json`).text();

async function resolved(name: string) {
  const body = JSON.parse(await payload(name));
  body.status = "resolved";
  for (const a of body.alerts) a.status = "resolved";
  return JSON.stringify(body);
}

test("a webhook returns the alert group key and starts a turn", async () => {
  const { turns, post } = setup();
  const res = await post("/alertmanager", await payload("kube-job-failed"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ alertname: "KubeJobFailed", namespace: "gallery-dl" });
  expect(turns).toHaveLength(1);
  expect(turns[0]!.text).toContain("Job gallery-dl/gallery-dl-29870000 failed to complete.");
});

test("a group without a namespace label has a null namespace", async () => {
  const { post } = setup();
  const res = await post("/alertmanager", await payload("watchdog"));
  expect(await res.json()).toEqual({ alertname: "Watchdog", namespace: null });
});

test("a repeat notification with the same firing alerts starts no turn", async () => {
  const { turns, post } = setup();
  await post("/alertmanager", await payload("kube-job-failed"));
  await post("/alertmanager", await payload("kube-job-failed"));
  expect(turns).toHaveLength(1);
});

test("resolving a group resumes its session", async () => {
  const { turns, post } = setup();
  await post("/alertmanager", await payload("kube-job-failed"));
  await post("/alertmanager", await resolved("kube-job-failed"));
  expect(turns).toHaveLength(2);
  expect(turns[1]!.sessionId).toBe(turns[0]!.sessionId);
});

test("a resolved notification for a group never seen firing starts no turn", async () => {
  const { turns, post } = setup();
  await post("/alertmanager", await resolved("kube-job-failed"));
  expect(turns).toHaveLength(0);
});

test("different groups get different sessions", async () => {
  const { turns, post } = setup();
  await post("/alertmanager", await payload("kube-job-failed"));
  await post("/alertmanager", await payload("watchdog"));
  expect(turns[1]!.sessionId).not.toBe(turns[0]!.sessionId);
});

test("a body that is not a webhook payload is rejected", async () => {
  const { turns, post } = setup();
  expect((await post("/alertmanager", "{}")).status).toBe(400);
  expect((await post("/alertmanager", "not json")).status).toBe(400);
  expect(turns).toHaveLength(0);
});

test("other paths are not found", async () => {
  const { post } = setup();
  expect((await post("/", "{}")).status).toBe(404);
});
