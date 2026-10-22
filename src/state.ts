import { readJson, updateJson } from "./storage.ts";

export interface WorkspaceState {
  version: 1;
  pinned: string[];
  recent: string[];
  sessions: Record<string, string>;
  discovered: string[];
}
const paths = (value: unknown): value is string[] => Array.isArray(value) && value.every((p) => typeof p === "string" && p.startsWith("/"));
export function parseState(value: unknown): WorkspaceState {
  if (value === undefined) return { version: 1, pinned: [], recent: [], sessions: {}, discovered: [] };
  const v = value as WorkspaceState;
  if (!v || v.version !== 1 || !paths(v.pinned) || !paths(v.recent) || !paths(v.discovered)
    || !v.sessions || typeof v.sessions !== "object" || Array.isArray(v.sessions)
    || !Object.entries(v.sessions).every(([k, p]) => k.startsWith("/") && typeof p === "string" && p.startsWith("/"))) {
    throw new Error("Invalid workspace-state.json; restore or repair it before continuing");
  }
  return v;
}
export const readState = async (file: string) => parseState(await readJson(file));
export const changeState = (file: string, change: (state: WorkspaceState) => void) => updateJson(file, parseState, change);
export function recordAccess(state: WorkspaceState, path: string, sessionFile?: string): void {
  state.recent = [path, ...state.recent.filter((p) => p !== path)].slice(0, 100);
  if (sessionFile) state.sessions[path] = sessionFile;
}
export function previousWorkspace(state: WorkspaceState, current: string): string | undefined {
  return state.recent.find((path) => path !== current);
}
