import { z } from "zod";
import { readTool, ToolError, type ReadTool } from "./contract";

export interface KubeConn {
  // The API server's base URL, without a trailing slash.
  url: string;
  // Read on each request, since a projected ServiceAccount token rotates.
  token: () => Promise<string | null>;
  ca?: string;
}

// The kinds the agent reads. ClusterRole `view` covers the namespaced ones and
// a second ClusterRole the cluster-scoped ones (docs/design/shape.md, Tools).
// Secrets and ConfigMaps are left out, so a read never asks for them.
const KINDS = {
  pods: { api: "api/v1", namespaced: true },
  events: { api: "api/v1", namespaced: true },
  services: { api: "api/v1", namespaced: true },
  persistentvolumeclaims: { api: "api/v1", namespaced: true },
  deployments: { api: "apis/apps/v1", namespaced: true },
  statefulsets: { api: "apis/apps/v1", namespaced: true },
  daemonsets: { api: "apis/apps/v1", namespaced: true },
  replicasets: { api: "apis/apps/v1", namespaced: true },
  jobs: { api: "apis/batch/v1", namespaced: true },
  cronjobs: { api: "apis/batch/v1", namespaced: true },
  ingresses: { api: "apis/networking.k8s.io/v1", namespaced: true },
  namespaces: { api: "api/v1", namespaced: false },
  nodes: { api: "api/v1", namespaced: false },
  persistentvolumes: { api: "api/v1", namespaced: false },
  storageclasses: { api: "apis/storage.k8s.io/v1", namespaced: false },
} as const;

type Kind = keyof typeof KINDS;
const kind = z.enum(Object.keys(KINDS) as [Kind, ...Kind[]]);

// Kubernetes object names. The patterns also keep a slash out of the request
// path, so a name cannot reach a subresource such as pods/log.
const namespace = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
const name = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/);

// A list beyond this says to narrow it with a selector.
const MAX_ROWS = 100;

// A log keeps its end, since the contract's cut at 30,000 characters keeps
// the start and JSON escaping can grow the text.
const MAX_LOG_LINES = 500;
const MAX_LOG_CHARS = 20_000;

async function request(c: KubeConn, path: string, signal: AbortSignal, accept = "application/json") {
  return (await send(c, path, signal, accept)).json();
}

async function send(c: KubeConn, path: string, signal: AbortSignal, accept: string): Promise<Response> {
  const token = await c.token();
  const res = await fetch(`${c.url}/${path}`, {
    headers: { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal,
    ...(c.ca ? { tls: { ca: c.ca } } : {}),
  });
  if (res.ok) return res;
  const message = ((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? res.statusText;
  if (res.status === 404) throw new ToolError(`not found: ${message}`, "List the kind to find the right name or namespace.");
  if (res.status === 403) {
    throw new ToolError(`the agent's role cannot read this: ${message}`, "Do not retry. Read something else, or answer with what you have.");
  }
  throw new ToolError(`the Kubernetes API answered ${res.status}: ${message}`, "Check the arguments, or answer with what you have.");
}

function path(k: Kind, ns: string | undefined): string {
  const { api, namespaced } = KINDS[k];
  return namespaced && ns ? `${api}/namespaces/${ns}/${k}` : `${api}/${k}`;
}

// Env values can hold credentials set inline, so only their names reach the
// model. valueFrom only names a source and stays.
function redactEnv(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactEnv);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [
      k,
      k === "env" && Array.isArray(x)
        ? x.map((e) => ("value" in e ? { ...e, value: "[redacted]" } : e))
        : redactEnv(x),
    ]),
  );
}

interface Table {
  columnDefinitions: { name: string; priority: number }[];
  rows: { cells: unknown[]; object?: { metadata?: { namespace?: string } } }[];
  metadata?: { continue?: string };
}

export function kubeTools(c: KubeConn): Record<string, ReadTool> {
  return {
    kube_get: readTool({
      description: "Read one Kubernetes object in full. Env values come back redacted.",
      input: z.object({
        kind,
        namespace: namespace.optional().describe("Required for namespaced kinds."),
        name,
      }),
      run: async ({ kind: k, namespace: ns, name: n }, signal) => {
        if (KINDS[k].namespaced && !ns) {
          throw new ToolError(`${k} are namespaced, and no namespace was given`, "Call again with the namespace.");
        }
        const obj = (await request(c, `${path(k, ns)}/${n}`, signal)) as { metadata?: Record<string, unknown> };
        const meta = { ...obj.metadata };
        delete meta.managedFields;
        if (meta.annotations) {
          const { "kubectl.kubernetes.io/last-applied-configuration": _, ...rest } = meta.annotations as Record<string, string>;
          meta.annotations = rest;
        }
        return redactEnv({ ...obj, metadata: meta });
      },
    }),
    kube_list: readTool({
      description:
        "List Kubernetes objects of one kind as the table `kubectl get` prints. Omit the namespace to list every namespace. Use events to see why a pod or job failed.",
      input: z.object({
        kind,
        namespace: namespace.optional(),
        labelSelector: z.string().max(500).optional().describe("Such as app=web."),
        fieldSelector: z.string().max(500).optional().describe("Such as involvedObject.name=web-0 for events."),
      }),
      run: async ({ kind: k, namespace: ns, labelSelector, fieldSelector }, signal) => {
        const query = new URLSearchParams({ limit: String(MAX_ROWS), includeObject: "Metadata" });
        if (labelSelector) query.set("labelSelector", labelSelector);
        if (fieldSelector) query.set("fieldSelector", fieldSelector);
        // The server renders the table, so columns follow each kind's kubectl view.
        const t = (await request(
          c,
          `${path(k, ns)}?${query}`,
          signal,
          "application/json;as=Table;v=v1;g=meta.k8s.io",
        )) as Table;
        // kubectl shows priority 0 columns unless asked for its wide view.
        const shown = t.columnDefinitions.flatMap((d, i) => (d.priority === 0 ? [i] : []));
        const allNamespaces = KINDS[k].namespaced && !ns;
        return {
          columns: [...(allNamespaces ? ["Namespace"] : []), ...shown.map((i) => t.columnDefinitions[i]!.name)],
          rows: t.rows.map((r) => [
            ...(allNamespaces ? [r.object?.metadata?.namespace ?? ""] : []),
            ...shown.map((i) => r.cells[i]),
          ]),
          ...(t.metadata?.continue ? { more: `More than ${MAX_ROWS} items exist. Narrow the list with a selector.` } : {}),
        };
      },
    }),
    kube_logs: readTool({
      description:
        "Read the last lines of one container's log. Set previous to read the run before the last restart, which holds why a crashed container exited.",
      input: z.object({
        namespace,
        pod: name,
        container: namespace.optional().describe("Required when the pod has more than one container."),
        previous: z.boolean().optional(),
        tailLines: z.number().int().min(1).max(MAX_LOG_LINES).optional().describe("100 when omitted."),
      }),
      run: async ({ namespace: ns, pod, container, previous, tailLines }, signal) => {
        const query = new URLSearchParams({ tailLines: String(tailLines ?? 100) });
        if (container) query.set("container", container);
        if (previous) query.set("previous", "true");
        const text = await (await send(c, `api/v1/namespaces/${ns}/pods/${pod}/log?${query}`, signal, "text/plain")).text();
        if (text.length <= MAX_LOG_CHARS) return { log: text };
        return {
          cut: `The first ${text.length - MAX_LOG_CHARS} characters were left out. Ask for fewer lines to see whole ones.`,
          log: text.slice(-MAX_LOG_CHARS),
        };
      },
    }),
  };
}
