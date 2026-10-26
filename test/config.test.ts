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
