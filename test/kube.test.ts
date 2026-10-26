import { afterAll, expect, test } from "bun:test";
import { kubeTools } from "../src/kube";
import { ToolError } from "../src/tools";

type Seen = { path: string; query: URLSearchParams; accept: string | null; authorization: string | null };
const seen: Seen[] = [];
let respond: (path: string) => Response = () => new Response(null, { status: 500 });

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    seen.push({
      path: url.pathname,
      query: url.searchParams,
      accept: req.headers.get("accept"),
      authorization: req.headers.get("authorization"),
    });
    return respond(url.pathname);
  },
});
afterAll(() => server.stop());

const tools = kubeTools({ url: server.url.href.replace(/\/$/, ""), token: async () => "sa-token" });
const signal = new AbortController().signal;
const last = () => seen.at(-1)!;

const pod = {
  kind: "Pod",
  metadata: {
    name: "web-0",
    namespace: "example-app",
    annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{...}", "example.com/owner": "team" },
    managedFields: [{ manager: "kubectl" }],
  },
  spec: {
    containers: [
      {
        name: "web",
        env: [
          { name: "TZ", value: "UTC" },
          { name: "DB_HOST", valueFrom: { secretKeyRef: { name: "example-db", key: "host" } } },
        ],
      },
    ],
  },
  status: { phase: "Running" },
};

test("kube_get reads one object with its bearer token, without managed fields, last-applied config or env values", async () => {
  respond = () => Response.json(pod);
  const out = (await tools.kube_get!.run({ kind: "pods", namespace: "example-app", name: "web-0" }, signal)) as Omit<typeof pod, "metadata"> & { metadata: Record<string, unknown> };

  expect(last().path).toBe("/api/v1/namespaces/example-app/pods/web-0");
  expect(last().authorization).toBe("Bearer sa-token");
  expect(out.metadata.managedFields).toBeUndefined();
  expect(out.metadata.annotations).toEqual({ "example.com/owner": "team" });
  expect(out.spec.containers[0]!.env).toEqual([
    { name: "TZ", value: "[redacted]" },
    { name: "DB_HOST", valueFrom: { secretKeyRef: { name: "example-db", key: "host" } } },
  ]);
  expect(out.status).toEqual({ phase: "Running" });
});

test("kube_get on a cluster-scoped kind ignores the namespace", async () => {
  respond = () => Response.json({ kind: "Node", metadata: { name: "node-1" } });
  await tools.kube_get!.run({ kind: "nodes", namespace: "example-app", name: "node-1" }, signal);
  expect(last().path).toBe("/api/v1/nodes/node-1");
});

test("kube_get on a namespaced kind without a namespace fails with a next step, before any request", async () => {
  const before = seen.length;
  const err = await tools.kube_get!.run({ kind: "deployments", name: "web" }, signal).catch((e: ToolError) => e) as ToolError;
  expect(err).toBeInstanceOf(ToolError);
  expect(err.next).toBeString();
  expect(seen).toHaveLength(before);
});

test("a name or namespace that is not a Kubernetes name is a bad argument", () => {
  const input = tools.kube_get!.input;
  expect(input.safeParse({ kind: "pods", namespace: "example-app", name: "web-0/log" }).success).toBe(false);
  expect(input.safeParse({ kind: "pods", namespace: "../..", name: "web-0" }).success).toBe(false);
  expect(input.safeParse({ kind: "secrets", namespace: "example-app", name: "web-0" }).success).toBe(false);
  expect(input.safeParse({ kind: "pods", namespace: "example-app", name: "web-0.example" }).success).toBe(true);
});

test("a missing object fails with a next step", async () => {
  respond = () => Response.json({ kind: "Status", message: 'pods "web-9" not found', reason: "NotFound" }, { status: 404 });
  const err = await tools.kube_get!.run({ kind: "pods", namespace: "example-app", name: "web-9" }, signal).catch((e: ToolError) => e) as ToolError;
  expect(err).toBeInstanceOf(ToolError);
  expect(err.message).toContain("web-9");
  expect(err.next).toBeString();
});

const table = {
  kind: "Table",
  columnDefinitions: [
    { name: "Name", priority: 0 },
    { name: "Ready", priority: 0 },
    { name: "Containers", priority: 1 },
  ],
  rows: [
    { cells: ["web", "1/1", "web"], object: { metadata: { name: "web", namespace: "example-app" } } },
    { cells: ["api", "0/1", "api"], object: { metadata: { name: "api", namespace: "example-other" } } },
  ],
  metadata: {},
};

test("kube_list across namespaces returns the server's table with a namespace column and no wide columns", async () => {
  respond = () => Response.json(table);
  const out = await tools.kube_list!.run({ kind: "deployments", labelSelector: "app=web" }, signal);

  expect(last().path).toBe("/apis/apps/v1/deployments");
  expect(last().query.get("labelSelector")).toBe("app=web");
  expect(last().accept).toContain("as=Table");
  expect(out).toMatchObject({
    columns: ["Namespace", "Name", "Ready"],
    rows: [
      ["example-app", "web", "1/1"],
      ["example-other", "api", "0/1"],
    ],
  });
});

test("kube_list in one namespace reads that namespace and says when more items exist", async () => {
  respond = () => Response.json({ ...table, metadata: { continue: "token" } });
  const out = (await tools.kube_list!.run({ kind: "events", namespace: "example-app" }, signal)) as Record<string, unknown>;

  expect(last().path).toBe("/api/v1/namespaces/example-app/events");
  expect(out.columns).toEqual(["Name", "Ready"]);
  expect(String(out.more)).toContain("selector");
});
