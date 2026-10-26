import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

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

test("LINK_ALLOWLIST lists hosts, case and spaces ignored", () => {
  const c = loadConfig({ ...base, MODEL: "claude-sonnet-5-5", LINK_ALLOWLIST: " Grafana.example.com, github.com ," });
  expect([...c.linkHosts]).toEqual(["grafana.example.com", "github.com"]);
});
