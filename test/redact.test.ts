import { expect, test } from "bun:test";
import { redact } from "../src/redact";

test("a password in a URL is redacted and the rest of the URL kept", () => {
  expect(redact("dsn postgres://app:hunter2@db.example.com:5432/app")).toBe(
    "dsn postgres://app:[redacted]@db.example.com:5432/app",
  );
});

test("a value under a secret-named key is redacted in env, YAML and JSON forms", () => {
  expect(redact("DB_PASSWORD=hunter2 next")).toBe("DB_PASSWORD=[redacted] next");
  expect(redact("  client_secret: hunter2\n")).toBe("  client_secret: [redacted]\n");
  expect(redact('{"apiKey":"hunter2","x":1}')).toBe('{"apiKey":"[redacted]","x":1}');
  expect(redact("GITHUB_TOKEN: hunter2")).toBe("GITHUB_TOKEN: [redacted]");
});

test("a key that names a secret without holding one keeps its value", () => {
  for (const s of ['"secretName":"example-db-credentials"', "tokenExpirationSeconds: 3600", '"key":"app.kubernetes.io/name"']) {
    expect(redact(s)).toBe(s);
  }
});

test("a bearer credential is redacted", () => {
  expect(redact("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [redacted]");
});

test("tokens in known formats are redacted wherever they appear", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJl";
  const github = "ghp_" + "a".repeat(36);
  const anthropic = "sk-ant-api03-" + "b".repeat(40);
  const aws = "AKIA" + "C".repeat(16);
  const out = redact(`a ${jwt} b ${github} c ${anthropic} d ${aws} e`);
  for (const t of [jwt, github, anthropic, aws]) expect(out).not.toContain(t);
  expect(out).toStartWith("a ");
  expect(out).toEndWith(" e");
});

test("a private key block is redacted, even when cut before its end line", () => {
  const block = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAKCAQEA\\n-----END RSA PRIVATE KEY-----";
  expect(redact(`x ${block} y`)).toBe("x [redacted private key] y");
  expect(redact("x -----BEGIN PRIVATE KEY-----\\nMIIEvQIBADAN")).toBe("x [redacted private key]");
});
