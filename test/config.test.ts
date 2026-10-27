import { expect, test } from "bun:test";
import { loadConfig, settingsFromYaml } from "../src/config";

const base = {
  ANTHROPIC_API_KEY: "sk-test",
  TURN_CAP_USD: "2",
  MONTHLY_CAP_USD: "40",
  DB_PATH: ":memory:",
  WEBHOOK_TOKEN: "test-token",
};

const override = {
  PRICE_INPUT: "1",
  PRICE_OUTPUT: "5",
  PRICE_CACHE_READ: "0.1",
  PRICE_CACHE_WRITE: "1.25",
};

test("a listed model takes its price from the built-in table", () => {
  // Claude Sonnet 5.5 row of https://platform.claude.com/docs/en/about-claude/pricing
  const c = loadConfig({ ...base, MODEL: "claude-sonnet-5-5" });
  expect(c.price).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
});

test("an unlisted model without a price fails at start", () => {
  expect(() => loadConfig({ ...base, MODEL: "claude-unknown-1" })).toThrow(/PRICE_INPUT/);
});

test("PRICE_* variables override the table", () => {
  const c = loadConfig({ ...base, MODEL: "claude-unknown-1", ...override });
  expect(c.price).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
});

test("a partial PRICE_* set fails at start instead of mixing with the table", () => {
  const { PRICE_CACHE_WRITE: _, ...partial } = override;
  expect(() => loadConfig({ ...base, MODEL: "claude-sonnet-5-5", ...partial })).toThrow(/PRICE_CACHE_WRITE/);
});

test("in a pod the Kubernetes API is the service address, read with the ServiceAccount", () => {
  const c = loadConfig({ ...base, MODEL: "claude-sonnet-5-5", KUBERNETES_SERVICE_HOST: "fd00::1", KUBERNETES_SERVICE_PORT: "443" });
  expect(c.kube).toEqual({ url: "https://[fd00::1]:443", serviceAccount: true });
});

test("KUBE_API_URL, such as a kubectl proxy, wins over the pod's service address", () => {
  const c = loadConfig({
    ...base,
    MODEL: "claude-sonnet-5-5",
    KUBERNETES_SERVICE_HOST: "10.0.0.1",
    KUBERNETES_SERVICE_PORT: "443",
    KUBE_API_URL: "http://127.0.0.1:8001/",
  });
  expect(c.kube).toEqual({ url: "http://127.0.0.1:8001", serviceAccount: false });
});

test("a read source left unset turns its tools off", () => {
  const c = loadConfig({ ...base, MODEL: "claude-sonnet-5-5" });
  expect([c.kube, c.prometheusUrl, c.lokiUrl, c.gitopsDir]).toEqual([null, null, null, null]);
});

const discordVars = { DISCORD_BOT_TOKEN: "t", DISCORD_CHANNEL_ID: "1", DISCORD_OWNER_ID: "2" };

test("the Discord bot is off without its variables and on with all three", () => {
  expect(loadConfig({ ...base, MODEL: "claude-sonnet-5-5" }).discord).toBeNull();
  expect(loadConfig({ ...base, MODEL: "claude-sonnet-5-5", ...discordVars }).discord).toEqual({
    token: "t",
    channelId: "1",
    ownerId: "2",
  });
});

test("a partial Discord configuration fails at start", () => {
  const { DISCORD_OWNER_ID: _, ...partial } = discordVars;
  expect(() => loadConfig({ ...base, MODEL: "claude-sonnet-5-5", ...partial })).toThrow(/DISCORD_OWNER_ID/);
});

const repos = { GITOPS_REPOS: "example-owner/example-platform, example-owner/example-apps" };
const githubVars = { GITHUB_APP_ID: "12345", GITHUB_APP_KEY: "pem", ...repos };

test("GITOPS_REPOS lists owner/name repositories in order, the first being the default", () => {
  const c = loadConfig({ ...base, MODEL: "claude-sonnet-5-5", ...githubVars, GITOPS_DIR: "/repos/gitops" });
  expect(c.gitopsRepos).toEqual(["example-owner/example-platform", "example-owner/example-apps"]);
  expect(c.gitopsDir).toBe("/repos/gitops");
});

test("a malformed or twice-named repository fails at start", () => {
  for (const GITOPS_REPOS of ["example-owner/a,example-apps", "example-owner/apps,other-owner/apps", "example-owner/.."]) {
    expect(() => loadConfig({ ...base, MODEL: "claude-sonnet-5-5", ...githubVars, GITOPS_REPOS })).toThrow(/GITOPS_REPOS/);
  }
});

test("GitOps reads need GITOPS_REPOS", () => {
  expect(() => loadConfig({ ...base, MODEL: "claude-sonnet-5-5", GITOPS_DIR: "/repos/gitops" })).toThrow(/GITOPS_REPOS/);
});

test("issues are off without the GitHub variables and on with both and GITOPS_REPOS", () => {
  expect(loadConfig({ ...base, MODEL: "claude-sonnet-5-5", ...repos }).github).toBeNull();
  expect(loadConfig({ ...base, MODEL: "claude-sonnet-5-5", ...githubVars }).github).toEqual({ appId: "12345", key: "pem" });
});

test("a partial GitHub configuration fails at start", () => {
  const { GITHUB_APP_KEY: _, ...partial } = githubVars;
  expect(() => loadConfig({ ...base, MODEL: "claude-sonnet-5-5", ...partial })).toThrow(/GITHUB_APP_KEY/);
  const { GITOPS_REPOS: __, ...noRepos } = githubVars;
  expect(() => loadConfig({ ...base, MODEL: "claude-sonnet-5-5", ...noRepos })).toThrow(/GITOPS_REPOS/);
});

test("LINK_ALLOWLIST lists hosts, case and spaces ignored", () => {
  const c = loadConfig({ ...base, MODEL: "claude-sonnet-5-5", LINK_ALLOWLIST: " Grafana.example.com, github.com ," });
  expect([...c.linkHosts]).toEqual(["grafana.example.com", "github.com"]);
});

// A local config.yaml takes the chart values' shape, so the deployment's
// values read the same. local holds what a pod gets from the chart itself.
const yaml = `
model: claude-sonnet-5-5
price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
turnCapUsd: 2
monthlyCapUsd: "40"
prometheusUrl: http://prometheus.example.com
lokiUrl: ""
linkAllowlist: [grafana.example.com, argocd.example.com]
discord:
  channelId: "100000000000000001"
  ownerId: "100000000000000002"
github:
  appId: "12345"
  installationId: "67890"
  gitopsRepos: [example-owner/example-apps, example-owner/example-hosts]
  instructionsRepo: example-owner/example-instructions
local:
  dbPath: ./ops-agent.sqlite
  port: 18080
  kubeApiUrl: http://127.0.0.1:8001
  gitopsDir: ""
  instructionsDir: ../example-instructions
`;

test("config.yaml maps each chart value and local setting to its variable, and skips what the agent does not read", () => {
  expect(settingsFromYaml(yaml)).toEqual({
    MODEL: "claude-sonnet-5-5",
    PRICE_INPUT: "1",
    PRICE_OUTPUT: "5",
    PRICE_CACHE_READ: "0.1",
    PRICE_CACHE_WRITE: "1.25",
    TURN_CAP_USD: "2",
    MONTHLY_CAP_USD: "40",
    PROMETHEUS_URL: "http://prometheus.example.com",
    LINK_ALLOWLIST: "grafana.example.com,argocd.example.com",
    DISCORD_CHANNEL_ID: "100000000000000001",
    DISCORD_OWNER_ID: "100000000000000002",
    GITHUB_APP_ID: "12345",
    GITOPS_REPOS: "example-owner/example-apps,example-owner/example-hosts",
    DB_PATH: "./ops-agent.sqlite",
    PORT: "18080",
    KUBE_API_URL: "http://127.0.0.1:8001",
    INSTRUCTIONS_DIR: "../example-instructions",
  });
});

test("a bare-number ID in config.yaml fails at start, since YAML rounds it", () => {
  expect(() => settingsFromYaml("discord:\n  channelId: 100000000000000001\n  ownerId: \"1\"\n")).toThrow(/discord.channelId/);
  expect(() => settingsFromYaml("github:\n  appId: 12345\n")).toThrow(/github.appId/);
});

test("an empty config.yaml sets nothing", () => {
  expect(settingsFromYaml("")).toEqual({});
});
