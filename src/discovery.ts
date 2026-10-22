import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { expandPath } from "./registry.ts";
import type { WorkspaceConfig } from "./config.ts";

/** Read-only, bounded, async walk. Child symlinks are deliberately not followed. */
export async function discoverRepositories(config: Pick<WorkspaceConfig, "roots" | "maxDepth" | "ignoredDirectories">, signal?: AbortSignal) {
  const found = new Set<string>();
  const visited = new Map<string, number>();
  const warnings: string[] = [];
  const ignored = new Set([".git", ...config.ignoredDirectories]);
  async function visit(input: string, depth: number) {
    signal?.throwIfAborted();
    let path: string;
    try {
      path = await realpath(input);
      if (!(await stat(path)).isDirectory()) return;
    } catch { warnings.push(`Cannot access ${input}`); return; }
    const previous = visited.get(path);
    if (previous !== undefined && previous <= depth) return;
    if (visited.size >= 20000) throw new Error("Discovery exceeded 20,000 directories; narrow roots or depth");
    visited.set(path, depth);
    try {
      const git = await lstat(join(path, ".git"));
      if (git.isDirectory() || git.isFile()) found.add(path); // .git files include worktrees and submodules.
    } catch { /* Not a repository or marker is inaccessible. */ }
    if (depth >= config.maxDepth) return;
    try {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory() && !ignored.has(entry.name)) await visit(join(path, entry.name), depth + 1);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if ((error as NodeJS.ErrnoException).code) warnings.push(`Cannot scan ${path}`); else throw error;
    }
  }
  for (const root of config.roots) await visit(expandPath(root, homedir()), 0);
  return { paths: [...found].sort(), warnings };
}
