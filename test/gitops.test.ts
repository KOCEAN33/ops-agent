import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitopsTools } from "../src/tools/gitops";
import { ToolError } from "../src/tools/contract";

const outside = await mkdtemp(join(tmpdir(), "gitops-outside-"));
const root = await mkdtemp(join(tmpdir(), "gitops-"));
afterAll(() => Promise.all([rm(root, { recursive: true }), rm(outside, { recursive: true })]));

await mkdir(join(root, "apps/example-app"), { recursive: true });
await mkdir(join(root, ".git"));
await writeFile(join(root, ".git/config"), "[core]\nmemoryLimit = 512Mi\n");
await writeFile(join(root, "apps/example-app/deployment.yaml"), "kind: Deployment\nspec:\n  resources:\n    limits:\n      memory: 512Mi\n");
await writeFile(join(root, "README.md"), "Cluster manifests.\n");
await writeFile(join(outside, "private.txt"), "memoryLimit outside\n");
await symlink(join(outside, "private.txt"), join(root, "apps/link.txt"));
await symlink(outside, join(root, "apps/linkdir"));
await symlink(join(root, ".git"), join(root, "apps/gitdir"));
await symlink(root, join(root, "apps/loop"));
await writeFile(
  join(root, "apps/example-app/secret.yaml"),
  [
    "apiVersion: v1",
    "kind: ConfigMap",
    "data:",
    "  mode: memoryLimit-normal",
    "---",
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    "  name: example-db",
    "data:",
    "  host: ZGIuZXhhbXBsZS5jb20=",
    "stringData:",
    "  config.yaml: |",
    "    memoryLimit: hunter2",
    "type: Opaque",
    "",
  ].join("\n"),
);

const tools = gitopsTools(root);
const signal = new AbortController().signal;
const read = (path: string) => tools.gitops_read!.run({ path }, signal);
const search = (text: string) => tools.gitops_search!.run({ text }, signal) as Promise<{ matches: { path: string; line: number; text: string }[]; more?: string }>;

test("gitops_read returns a file's content", async () => {
  expect(await read("apps/example-app/deployment.yaml")).toMatchObject({ content: expect.stringContaining("memory: 512Mi") });
});

test("gitops_read lists a directory, marking subdirectories and hiding .git", async () => {
  expect(await read("")).toMatchObject({ entries: ["README.md", "apps/"] });
  expect(await read("apps/example-app")).toMatchObject({ entries: ["deployment.yaml", "secret.yaml"] });
});

test("gitops_read refuses paths outside the clone or inside .git", async () => {
  for (const p of ["../", "apps/../../", "apps/link.txt", ".git/config", "/etc/hosts"]) {
    const err = await read(p).catch((e: ToolError) => e) as ToolError;
    expect(err).toBeInstanceOf(ToolError);
  }
});

test("gitops_read of a missing path fails with a next step", async () => {
  const err = await read("apps/missing.yaml").catch((e: ToolError) => e) as ToolError;
  expect(err).toBeInstanceOf(ToolError);
  expect(err.next).toBeString();
});

test("values in a Secret manifest are redacted, and other documents in the file are not", async () => {
  const { content } = (await read("apps/example-app/secret.yaml")) as { content: string };
  expect(content).not.toContain("ZGIuZXhhbXBsZS5jb20=");
  expect(content).not.toContain("hunter2");
  expect(content).toContain("  host: [redacted]");
  expect(content).toContain("mode: memoryLimit-normal");
  expect(content).toContain("name: example-db");
  expect(content).toContain("type: Opaque");
});

test("gitops_search finds text case-insensitively, outside .git, symlinks and Secret values", async () => {
  const { matches } = await search("MEMORYLIMIT");
  expect(matches).toEqual([{ path: "apps/example-app/secret.yaml", line: 4, text: "  mode: memoryLimit-normal" }]);
});

test("gitops_search says when it stopped at its match cap", async () => {
  await writeFile(join(root, "many.txt"), "needle\n".repeat(500));
  const out = await search("needle");
  expect(out.matches.length).toBeLessThan(500);
  expect(out.more).toBeString();
});
