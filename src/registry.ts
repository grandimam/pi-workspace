import { constants } from "node:fs";
import { access, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout } from "node:timers/promises";

export function expandPath(value: string, cwd: string): string {
  if (!value.trim()) throw new Error("Enter a directory path");
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  if (value.startsWith("~")) throw new Error("Use ~ or ~/path, not ~username");
  return resolve(cwd, value);
}

export async function validateDirectory(value: string, cwd: string): Promise<string> {
  const path = await realpath(expandPath(value, cwd));
  if (!(await stat(path)).isDirectory()) throw new Error("Choose a directory, not a file");
  await access(path, constants.R_OK | constants.X_OK);
  return path;
}

export async function readRegistry(file: string): Promise<string[]> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const data = JSON.parse(text);
  if (data?.version !== 1 || !Array.isArray(data.paths) || !data.paths.every((p: unknown) => typeof p === "string" && p.startsWith("/"))) {
    throw new Error(`Invalid workspace registry: ${file}`);
  }
  return [...new Set<string>(data.paths)];
}

/** Atomic replacement plus a cross-process lock avoids losing another Pi's registration. */
export async function registerDirectory(file: string, value: string, cwd: string): Promise<string> {
  const path = await validateDirectory(value, cwd);
  await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let held = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const fd = await open(lock, "wx", 0o600);
      await fd.close();
      held = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await setTimeout(50);
    }
  }
  if (!held) throw new Error(`Registry busy. Retry; if no Pi is writing, remove stale lock: ${lock}`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const paths = await readRegistry(file);
    if (!paths.includes(path)) paths.push(path);
    const fd = await open(temporary, "wx", 0o600);
    try {
      await fd.writeFile(`${JSON.stringify({ version: 1, paths }, null, 2)}\n`);
      await fd.sync();
    } finally { await fd.close(); }
    await rename(temporary, file);
    return path;
  } finally {
    await unlink(temporary).catch(() => {});
    await unlink(lock);
  }
}
