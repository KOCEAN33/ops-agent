import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { readTool, ToolError, type ReadTool } from "./contract";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_MATCHES = 100;
const MAX_LINE = 300;

// Values under data and stringData in a Secret manifest. Pattern redaction in
// src/redact.ts catches a value only under a secret-sounding key, and a
// Secret's keys are often plain, such as host or tls.key.
export function redactSecrets(text: string): string {
  return text
    .split(/^(?=---)/m)
    .map((doc) => {
      if (!/^kind:\s*Secret\s*$/m.test(doc)) return doc;
      // The indent of the data or stringData line, and of its keys. Lines below
      // a key, such as a block scalar's, are value too.
      let indent = -1;
      let keyIndent = -1;
      return doc
        .split("\n")
        .map((line) => {
          const lead = line.length - line.trimStart().length;
          if (indent >= 0 && line.trim() && lead > indent) {
            if (keyIndent < 0) keyIndent = lead;
            const key = lead === keyIndent ? /^\s*([^:\s]+:)/.exec(line)?.[1] : undefined;
            return `${line.slice(0, lead)}${key ? `${key} ` : ""}[redacted]`;
          }
          const section = /^(\s*)(data|stringData):\s*$/.exec(line);
          if (section) [indent, keyIndent] = [section[1]!.length, -1];
          else if (line.trim()) indent = -1;
          return line;
        })
        .join("\n");
    })
    .join("");
}

// The clone's root is resolved on each call, since a sync sidecar such as
// git-sync swaps a symlink to the new worktree on each update.
async function resolve(root: string, path: string) {
  const top = await realpath(root);
  const real = await realpath(join(top, path)).catch(() => {
    throw new ToolError(`${path} does not exist in the repository`, "Read its parent directory to see what exists.");
  });
  const rel = relative(top, real);
  if (rel.startsWith("..") || rel.split(sep).includes(".git")) {
    throw new ToolError(`${path} is outside the repository`, "Use a path inside the repository, outside .git.");
  }
  return { top, real, rel };
}

// Every regular file under dir, outside .git. A symlink is neither a file nor
// a directory to a Dirent, so the walk never follows one out of the clone.
async function walk(top: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(top, p)));
    else if (e.isFile()) out.push(relative(top, p));
  }
  return out;
}

async function text(file: string, path: string) {
  if ((await stat(file)).size > MAX_FILE_BYTES) {
    throw new ToolError(`${path} is over ${MAX_FILE_BYTES} bytes`, "Use gitops_search to find the lines you need.");
  }
  const t = await readFile(file, "utf8");
  if (t.includes("\0")) throw new ToolError(`${path} is a binary file`, "Read a text file instead.");
  return redactSecrets(t);
}

// dir holds one clone per repository, at <dir>/<name>/current. names are the
// repository names without their owner, so the model never sees an owner.
export function gitopsTools(dir: string, names: [string, ...string[]]): Record<string, ReadTool> {
  const repo = z.enum(names).describe("The repository to use.");
  const root = (name: string) => join(dir, name, "current");
  const listed = names.join(", ");
  return {
    gitops_read: readTool({
      description: `Read a file or list a directory in a GitOps repository at main. The repositories: ${listed}. Paths are relative to the repository root, and an empty path lists the root.`,
      input: z.object({ repo, path: z.string().max(500) }),
      run: async ({ repo, path }) => {
        const { real, rel } = await resolve(root(repo), path);
        if (!(await stat(real)).isDirectory()) return { path: rel, content: await text(real, rel) };
        const all = (await readdir(real, { withFileTypes: true }))
          .filter((e) => e.name !== ".git")
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return {
          path: rel,
          entries: all.slice(0, MAX_ENTRIES),
          ...(all.length > MAX_ENTRIES ? { more: `${all.length - MAX_ENTRIES} more entries` } : {}),
        };
      },
    }),
    gitops_search: readTool({
      description: `Find lines containing a text in a GitOps repository, ignoring case. The repositories: ${listed}. Returns up to ${MAX_MATCHES} matches with their path and line number.`,
      input: z.object({
        repo,
        text: z.string().min(2).max(200),
        path: z.string().max(500).optional().describe("A directory to search under. Defaults to the whole repository."),
      }),
      run: async ({ repo, text: needle, path = "" }, signal) => {
        const { top, real } = await resolve(root(repo), path);
        const want = needle.toLowerCase();
        const matches: { path: string; line: number; text: string }[] = [];
        for (const file of (await walk(top, real)).sort()) {
          if (signal.aborted) break;
          const lines = (await text(join(top, file), file).catch(() => "")).split("\n");
          for (const [i, line] of lines.entries()) {
            if (!line.toLowerCase().includes(want)) continue;
            if (matches.length === MAX_MATCHES) {
              return { matches, more: `Stopped at ${MAX_MATCHES} matches. Search a narrower path or a longer text.` };
            }
            matches.push({ path: file, line: i + 1, text: line.slice(0, MAX_LINE) });
          }
        }
        return { matches };
      },
    }),
  };
}
