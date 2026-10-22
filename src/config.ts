import { readJson } from "./storage.ts";
import type { KeyId } from "@earendil-works/pi-tui";
export interface WorkspaceConfig {
  roots: string[];
  maxDepth: number;
  ignoredDirectories: string[];
  pickerShortcut: KeyId;
  previousShortcut: KeyId;
  showStatus: boolean;
  showBranch: boolean;
  showSessionCount: boolean;
  contentSearch: boolean;
}
export const defaults: WorkspaceConfig = {
  roots: [], maxDepth: 3,
  ignoredDirectories: [".git", "node_modules", ".venv", "venv", "vendor", "dist", "build", ".cache"],
  pickerShortcut: "ctrl+x", previousShortcut: "ctrl+alt+p",
  showStatus: true, showBranch: true, showSessionCount: true, contentSearch: false,
};
export async function readConfig(file: string): Promise<WorkspaceConfig> {
  const value = await readJson(file);
  if (value === undefined) return { ...defaults };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workspace config must be an object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!(key in defaults)) throw new Error(`Unknown workspace setting: ${key}`);
  const c = { ...defaults, ...input } as WorkspaceConfig;
  if (!Array.isArray(c.roots) || !c.roots.every((x) => typeof x === "string" && x.length > 0)) throw new Error("roots must be directory paths");
  if (!Number.isInteger(c.maxDepth) || c.maxDepth < 0 || c.maxDepth > 20) throw new Error("maxDepth must be 0–20");
  if (!Array.isArray(c.ignoredDirectories) || !c.ignoredDirectories.every((x) => typeof x === "string" && x.length && !x.includes("/"))) throw new Error("ignoredDirectories must be directory names");
  for (const key of ["showStatus", "showBranch", "showSessionCount", "contentSearch"] as const) {
    if (typeof c[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  for (const key of ["pickerShortcut", "previousShortcut"] as const) {
    if (typeof c[key] !== "string" || !/^(?:(?:ctrl|alt|shift)\+)*(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/.test(c[key])) throw new Error(`Invalid ${key}; use a modified letter or function key`);
    if (!c[key].includes("+") && !/^f\d+$/.test(c[key])) throw new Error(`${key} must not shadow normal typing`);
    if (c[key] === "alt+tab") throw new Error("Alt+Tab is intercepted by most operating systems");
  }
  if (c.pickerShortcut === c.previousShortcut) throw new Error("Workspace shortcuts must differ");
  return c;
}
