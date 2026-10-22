import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { readJson, updateJson } from "./storage.ts";

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
function parseRegistry(value: unknown): { version: 1; paths: string[] } {
  if (value === undefined) return { version: 1, paths: [] };
  const data = value as { version: number; paths: unknown };
  if (!data || data.version !== 1 || !Array.isArray(data.paths) || !data.paths.every((p) => typeof p === "string" && p.startsWith("/"))) {
    throw new Error("Invalid workspace registry; repair workspaces.json before continuing");
  }
  return { version: 1, paths: [...new Set<string>(data.paths)] };
}
export async function readRegistry(file: string): Promise<string[]> {
  return parseRegistry(await readJson(file)).paths;
}
export async function registerDirectory(file: string, value: string, cwd: string): Promise<string> {
  const path = await validateDirectory(value, cwd);
  await updateJson(file, parseRegistry, (registry) => { if (!registry.paths.includes(path)) registry.paths.push(path); });
  return path;
}
