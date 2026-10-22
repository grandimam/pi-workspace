import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { expandPath, validateDirectory } from "./registry.ts";

export async function childDirectories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      // Follow a link only to inspect this immediate child, never recursively.
      if (entry.isSymbolicLink() && !(await stat(join(path, entry.name))).isDirectory()) continue;
      await validateDirectory(join(path, entry.name), path);
      names.push(entry.name);
    } catch { /* Inaccessible children and broken links are not navigation targets. */ }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export async function completeDirectory(value: string, cwd: string): Promise<{ value: string; count: number }> {
  const absolute = expandPath(value || ".", cwd);
  const atDirectory = !value || value.endsWith(sep) || value === "~";
  const parent = atDirectory ? absolute : dirname(absolute);
  const prefix = atDirectory ? "" : basename(absolute);
  const matches = (await childDirectories(parent)).filter((name) => name.startsWith(prefix));
  if (!matches.length) return { value, count: 0 };
  let common = matches[0];
  for (const name of matches.slice(1)) {
    while (!name.startsWith(common)) common = common.slice(0, -1);
  }
  return { value: join(parent, common) + (matches.length === 1 || !common ? sep : ""), count: matches.length };
}
