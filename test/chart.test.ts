import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Metrics } from "../src/metrics";

const CHART = join(import.meta.dir, "..", "chart");
const helm = Bun.which("helm");

const example = {
  image: { repository: "registry.example.com/ghcr/example/ops-agent", tag: "1.0.0" },
  turnCapUsd: 1,
  monthlyCapUsd: 40,
  secret: { name: "ops-agent" },
  prometheusUrl: "http://prometheus.example.svc:9090",
  lokiUrl: "http://loki.example.svc:3100",
  linkAllowlist: ["grafana.example.com"],
  discord: { channelId: "100", ownerId: "200" },
  github: { appId: "12345", installationId: "678", gitopsRepos: ["example-owner/example.platform", "example-owner/example-apps"], instructionsRepo: "example-owner/example-instructions" },
  alertmanager: {
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "example-monitoring" } },
    podSelector: { matchLabels: { "app.kubernetes.io/name": "alertmanager" } },
  },
  ciliumEgress: { enabled: true, inCluster: [{ namespace: "example-monitoring", podLabels: { app: "prometheus" }, ports: [9090] }] },
};

type Doc = { kind: string; metadata: { name: string; labels?: Record<string, string> }; [k: string]: any };

// Renders the chart with values. Returns the documents, or the error text.
function render(values: unknown): { docs: Doc[]; error: string } {
  const file = join(mkdtempSync(join(tmpdir(), "ops-agent-chart-")), "values.json");
  writeFileSync(file, JSON.stringify(values));
  const r = Bun.spawnSync([helm!, "template", "t", CHART, "-f", file]);
  const out = r.stdout.toString();
  const docs = out
    .split(/^---$/m)
    .map((d) => Bun.YAML.parse(d) as Doc | null)
    .filter((d): d is Doc => !!d);
  return { docs, error: r.stderr.toString() };
}

const one = (docs: Doc[], kind: string, name?: string) => {
  const found = docs.filter((d) => d.kind === kind && (!name || d.metadata.name === name));
  expect(found).toHaveLength(1);
  return found[0]!;
};

test.skipIf(!helm)("the chart lints", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ops-agent-chart-")), "values.json");
  writeFileSync(file, JSON.stringify(example));
  const r = Bun.spawnSync([helm!, "lint", "--strict", CHART, "-f", file]);
  expect(r.stdout.toString() + r.stderr.toString()).toContain("0 chart(s) failed");
});

test.skipIf(!helm)("one replica runs, and the old pod stops before the new one starts", () => {
  const d = one(render(example).docs, "Deployment");
  expect(d.spec.replicas).toBe(1);
  expect(d.spec.strategy).toEqual({ type: "Recreate" });
});

test.skipIf(!helm)("the ServiceAccount reads through view and a ClusterRole for the cluster kinds view leaves out", () => {
  const { docs } = render(example);
  const sa = one(docs, "ServiceAccount").metadata.name;
  expect(one(docs, "Deployment").spec.template.spec.serviceAccountName).toBe(sa);
  const bindings = docs.filter((d) => d.kind === "ClusterRoleBinding");
  for (const b of bindings) expect(b.subjects).toEqual([{ kind: "ServiceAccount", name: sa, namespace: expect.any(String) }]);
  expect(bindings.map((b) => b.roleRef.name).sort()).toEqual(["t-ops-agent-cluster-read", "view"]);
  expect(one(docs, "ClusterRole").rules).toEqual([
    { apiGroups: [""], resources: ["nodes", "persistentvolumes"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["storage.k8s.io"], resources: ["storageclasses"], verbs: ["get", "list", "watch"] },
  ]);
  expect(docs.filter((d) => d.kind === "Role" || d.kind === "RoleBinding")).toEqual([]);
});

test.skipIf(!helm)("ingress to the agent comes from Alertmanager alone", () => {
  const p = one(render(example).docs, "NetworkPolicy");
  expect(p.spec.policyTypes).toEqual(["Ingress"]);
  expect(p.spec.ingress).toEqual([
    {
      from: [{ namespaceSelector: example.alertmanager.namespaceSelector, podSelector: example.alertmanager.podSelector }],
      ports: [{ port: "http" }],
    },
  ]);
});

const scraper = {
  namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "example-monitoring" } },
  podSelector: { matchLabels: { "app.kubernetes.io/name": "prometheus" } },
};

test.skipIf(!helm)("with a scraper set, it alone reaches the metrics port, which a PodMonitor scrapes", () => {
  const { docs } = render({ ...example, metrics: { scraper, podMonitor: { labels: { release: "example" } } } });
  expect(one(docs, "NetworkPolicy").spec.ingress).toEqual([
    {
      from: [{ namespaceSelector: example.alertmanager.namespaceSelector, podSelector: example.alertmanager.podSelector }],
      ports: [{ port: "http" }],
    },
    { from: [scraper], ports: [{ port: "metrics" }] },
  ]);
  const c = one(docs, "Deployment").spec.template.spec.containers[0];
  const port = c.ports.find((p: any) => p.name === "metrics");
  expect(c.env).toContainEqual({ name: "METRICS_PORT", value: String(port.containerPort) });
  const m = one(docs, "PodMonitor");
  expect(m.metadata.labels).toMatchObject({ release: "example" });
  expect(m.spec.selector.matchLabels).toEqual(one(docs, "Deployment").spec.selector.matchLabels);
  expect(m.spec.podMetricsEndpoints).toEqual([expect.objectContaining({ port: "metrics", path: "/metrics" })]);
  // Prometheus names a PodMonitor's job <namespace>/<name>, and the spend seed
  // reads only that job's series. helm template renders into "default".
  expect(c.env).toContainEqual({ name: "SPEND_SEED_JOB", value: `default/${m.metadata.name}` });
});

test.skipIf(!helm)("without a scraper, no PodMonitor is made and the metrics port admits nothing", () => {
  const { docs } = render(example);
  expect(docs.filter((d) => d.kind === "PodMonitor")).toEqual([]);
  expect(one(docs, "NetworkPolicy").spec.ingress).toHaveLength(1);
});

test.skipIf(!helm)("with Litestream on, an init container restores the file before a sidecar replicates it, and only they hold the R2 credentials", () => {
  const { docs } = render({ ...example, litestream: { enabled: true, path: "ops-agent" } });
  const pod = one(docs, "Deployment").spec.template.spec;
  const agent = pod.containers.find((c: any) => c.name === "ops-agent");
  const dbPath = agent.env.find((e: any) => e.name === "DB_PATH").value;
  const [restore, replicate] = pod.initContainers;

  expect(restore.args).toEqual(expect.arrayContaining(["restore", "-if-db-not-exists", "-if-replica-exists", dbPath]));
  expect(restore.restartPolicy).toBeUndefined();
  expect(replicate.args).toEqual(expect.arrayContaining(["replicate"]));
  expect(replicate.restartPolicy).toBe("Always");

  const r2 = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  for (const c of [restore, replicate]) {
    for (const name of r2) expect(c.env).toContainEqual({ name, valueFrom: { secretKeyRef: { name: "ops-agent", key: name } } });
    expect(c.volumeMounts).toContainEqual(expect.objectContaining({ name: "data", mountPath: agent.volumeMounts.find((m: any) => m.name === "data").mountPath }));
  }
  expect(agent.env.map((e: any) => e.name)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^R2_/)]));

  const config = Bun.YAML.parse(one(docs, "ConfigMap").data["litestream.yml"]) as any;
  expect(config.dbs).toHaveLength(1);
  expect(config.dbs[0].path).toBe(dbPath);
  expect(config.dbs[0].replica).toMatchObject({ type: "s3", path: "ops-agent", region: "auto", endpoint: "${R2_ENDPOINT}", bucket: "${R2_BUCKET}" });
});

test.skipIf(!helm)("with Litestream and a scraper, Litestream's metrics are scraped and its replication errors alert", () => {
  const { docs } = render({ ...example, litestream: { enabled: true }, metrics: { scraper } });
  const replicate = one(docs, "Deployment").spec.template.spec.initContainers.find((c: any) => c.name === "litestream");
  const port = replicate.ports.find((p: any) => p.name === "ls-metrics").containerPort;
  const config = Bun.YAML.parse(one(docs, "ConfigMap").data["litestream.yml"]) as any;
  expect(config.addr).toBe(`:${port}`);

  // By number: Cilium resolves a named port only from the pod's containers,
  // not from a native sidecar's.
  expect(one(docs, "NetworkPolicy").spec.ingress[1]).toEqual({ from: [scraper], ports: [{ port: "metrics" }, { port }] });
  expect(one(docs, "PodMonitor").spec.podMetricsEndpoints.map((e: any) => e.port)).toEqual(["metrics", "ls-metrics"]);

  const rules = one(docs, "PrometheusRule").spec.groups.flatMap((g: any) => g.rules);
  const exprs = rules.map((r: any) => r.expr).join("\n");
  expect(exprs).toContain("litestream_sync_error_count");
  expect(exprs).toContain("litestream_replica_operation_errors_total");
  for (const r of rules) expect(r.labels.severity).toBe("warning");
});

test.skipIf(!helm)("with Litestream off, no container restores or replicates", () => {
  const { docs } = render(example);
  expect(one(docs, "Deployment").spec.template.spec.initContainers).toBeUndefined();
  expect(docs.filter((d) => d.kind === "ConfigMap")).toEqual([]);
});

test.skipIf(!helm)("the chart refuses to render without an Alertmanager selector", () => {
  const { alertmanager: _, ...rest } = example;
  expect(render(rest).error).toContain("alertmanager");
});

test.skipIf(!helm)("every credential comes from the Secret and none from a plain value", () => {
  const { docs } = render(example);
  const pod = one(docs, "Deployment").spec.template.spec;
  const env = Object.fromEntries(pod.containers[0].env.map((e: any) => [e.name, e]));
  for (const name of ["ANTHROPIC_API_KEY", "WEBHOOK_TOKEN", "DISCORD_BOT_TOKEN", "GITHUB_APP_KEY"]) {
    expect(env[name]).toEqual({ name, valueFrom: { secretKeyRef: { name: "ops-agent", key: name } } });
  }
  expect(docs.filter((d) => d.kind === "Secret")).toEqual([]);
  // git-sync reads the same App key as a file from the Secret.
  const keyVolume = pod.volumes.find((v: any) => v.secret);
  expect(keyVolume.secret).toMatchObject({ secretName: "ops-agent", items: [{ key: "GITHUB_APP_KEY", path: "key.pem" }] });
});

test.skipIf(!helm)("egress reaches DNS, the API server, the listed endpoints and HTTPS hosts by name, and no wider range", () => {
  const p = one(render(example).docs, "CiliumNetworkPolicy");
  const rules = p.spec.egress as Record<string, unknown>[];
  expect(rules.flatMap((r) => Object.keys(r).filter((k) => k !== "toPorts")).sort()).toEqual([
    "toEndpoints",
    "toEndpoints",
    "toEntities",
    "toFQDNs",
  ]);
  expect(rules.find((r) => r.toEntities)!.toEntities).toEqual(["kube-apiserver"]);
  const fqdn = rules.find((r) => r.toFQDNs)!;
  expect(fqdn.toPorts).toEqual([{ ports: [{ port: "443", protocol: "TCP" }] }]);
});

test.skipIf(!helm)("each repository gets a git-sync sidecar whose root the agent mounts whole", () => {
  const pod = one(render(example).docs, "Deployment").spec.template.spec;
  const agent = pod.containers[0];
  const env = Object.fromEntries(agent.env.map((e: any) => [e.name, e.value]));
  expect(env.GITOPS_DIR).toBe("/repos/gitops");
  expect(env.GITOPS_REPOS).toBe("example-owner/example.platform,example-owner/example-apps");
  expect(env.INSTRUCTIONS_DIR).toBe("/repos/instructions/current");
  // A repository name need not be a DNS label, so volumes go by index.
  for (const [volume, repo, mountPath] of [
    ["gitops-0", "example-owner/example.platform", "/repos/gitops/example.platform"],
    ["gitops-1", "example-owner/example-apps", "/repos/gitops/example-apps"],
    ["instructions", "example-owner/example-instructions", "/repos/instructions"],
  ]) {
    const sidecar = pod.containers.find((c: any) => c.name === `git-sync-${volume}`);
    expect(sidecar.args).toContain(`--repo=https://github.com/${repo}`);
    expect(sidecar.args).toContain("--link=current");
    expect(sidecar.args).toContain("--root=/git");
    expect(sidecar.args).toContain("--git-config=safe.directory:/git");
    expect(sidecar.volumeMounts).toContainEqual({ name: volume, mountPath: "/git" });
    expect(agent.volumeMounts).toContainEqual({ name: volume, mountPath, readOnly: true });
    expect(pod.volumes).toContainEqual({ name: volume, emptyDir: {} });
  }
  expect(pod.containers.filter((c: any) => c.name.startsWith("git-sync-"))).toHaveLength(3);
});

test.skipIf(!helm)("issues turn on with the App ID and the repository list", () => {
  const env = (values: unknown) =>
    one(render(values).docs, "Deployment").spec.template.spec.containers[0].env.map((e: any) => e.name) as string[];
  expect(env(example)).toEqual(expect.arrayContaining(["GITHUB_APP_ID", "GITHUB_APP_KEY", "GITOPS_REPOS"]));
  const noRepos = env({ ...example, github: { ...example.github, gitopsRepos: [] } });
  expect(noRepos).not.toContain("GITHUB_APP_ID");
  expect(noRepos).not.toContain("GITOPS_REPOS");
});

test.skipIf(!helm)("an ID written as a YAML number fails the render instead of turning into a float", () => {
  for (const over of [
    { discord: { channelId: 123456789012345678, ownerId: "200" } },
    { discord: { channelId: "100", ownerId: 223456789012345679 } },
    { github: { ...example.github, appId: 1234567 } },
    { github: { ...example.github, installationId: 87654321 } },
  ]) {
    const { docs, error } = render({ ...example, ...over });
    expect(docs).toEqual([]);
    expect(error).toContain("quote");
  }
});

test.skipIf(!helm)("a half Discord configuration fails the render", () => {
  const { docs, error } = render({ ...example, discord: { channelId: "100" } });
  expect(docs).toEqual([]);
  expect(error).toContain("discord.ownerId");
});

test.skipIf(!helm)("an enabled dashboard is a ConfigMap the sidecar loads, whose agent queries name only exported metrics", () => {
  expect(render(example).docs.filter((d) => d.kind === "ConfigMap")).toEqual([]);
  const { docs } = render({ ...example, metrics: { dashboard: { enabled: true, annotations: { grafana_folder: "Example" } } } });
  const cm = one(docs, "ConfigMap");
  expect(cm.metadata.labels).toEqual(expect.objectContaining({ grafana_dashboard: "1" }));
  expect((cm.metadata as any).annotations).toEqual({ grafana_folder: "Example" });
  const dashboard = JSON.parse(cm.data["ops-agent.json"]);
  const exprs: string[] = dashboard.panels.flatMap((p: any) => (p.targets ?? []).map((t: any) => t.expr));
  const exported = new Set([...new Metrics().text().matchAll(/^# TYPE (\S+) (\S+)/gm)].flatMap(([, name, type]) =>
    type === "histogram" ? [`${name}_bucket`, `${name}_sum`, `${name}_count`] : [name!]));
  const used = exprs.flatMap((e) => e.match(/ops_agent_\w+/g) ?? []);
  expect(used.length).toBeGreaterThan(0);
  for (const name of used) expect(exported).toContain(name);
});
