import { expect, test } from "bun:test";
import { handle } from "../src/server";

function post(path: string, body: string) {
  return handle(new Request(`http://localhost${path}`, { method: "POST", body }));
}

const payload = (name: string) => Bun.file(`${import.meta.dir}/payloads/${name}.json`).text();

test("a webhook returns the alert group key", async () => {
  const res = await post("/alertmanager", await payload("kube-job-failed"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ alertname: "KubeJobFailed", namespace: "gallery-dl" });
});

test("a group without a namespace label has a null namespace", async () => {
  const res = await post("/alertmanager", await payload("watchdog"));
  expect(await res.json()).toEqual({ alertname: "Watchdog", namespace: null });
});

test("a body that is not a webhook payload is rejected", async () => {
  expect((await post("/alertmanager", "{}")).status).toBe(400);
  expect((await post("/alertmanager", "not json")).status).toBe(400);
});

test("other paths are not found", async () => {
  expect((await post("/", "{}")).status).toBe(404);
});
