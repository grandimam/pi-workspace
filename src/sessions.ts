import { open, realpath } from "node:fs/promises";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { validateDirectory } from "./registry.ts";

export type WorkspaceSession = SessionInfo & { workspace: string };
export interface SessionTarget { workspace: string; file?: string; create?: boolean }

/** Pi's public factory owns ids and paths. Materialize only its documented JSONL header.
 * create() alone is lazy and has no public flush; no invented assistant messages are added.
 * Exclusive creation never rewrites an existing session. Runtime creation still belongs to Pi.
 */
export async function createWorkspaceSession(path: string, sessionDir?: string): Promise<string> {
  const cwd = await validateDirectory(path, path);
  const manager = SessionManager.create(cwd, sessionDir);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error("Pi did not allocate a persistent session");
  const fd = await open(file, "wx", 0o600);
  try { await fd.writeFile(`${JSON.stringify(header)}\n`); await fd.sync(); }
  finally { await fd.close(); }
  return file;
}

export async function validateSession(file: string, workspace: string): Promise<void> {
  const expected = await validateDirectory(workspace, workspace);
  const fd = await open(file, "r");
  try {
    if (!(await fd.stat()).isFile()) throw new Error("Session is not a regular file");
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const end = text.indexOf("\n");
    if (end < 0) throw new Error("Invalid session header");
    const header = JSON.parse(text.slice(0, end));
    if (header.type !== "session" || !header.id || typeof header.cwd !== "string"
      || await realpath(header.cwd) !== expected) throw new Error("Session does not belong to this workspace");
  } finally { await fd.close(); }
}

export async function indexSessions(sessions: SessionInfo[]): Promise<WorkspaceSession[]> {
  const canonical = new Map<string, string | undefined>();
  const result: WorkspaceSession[] = [];
  for (const session of sessions) {
    if (!session.cwd) continue;
    if (!canonical.has(session.cwd)) {
      try { canonical.set(session.cwd, await realpath(session.cwd)); } catch { canonical.set(session.cwd, undefined); }
    }
    const workspace = canonical.get(session.cwd);
    if (workspace) result.push({ ...session, workspace });
  }
  return result.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
export const sessionTitle = (session: WorkspaceSession) => session.name || session.firstMessage?.replace(/\s+/g, " ").slice(0, 100) || "New session";

/** Dates are UTC, inclusive; content is searched in memory only when explicitly enabled. */
export function searchSessions(sessions: WorkspaceSession[], query: string, content = false): WorkspaceSession[] {
  let candidates = sessions;
  const text: string[] = [];
  for (const word of query.trim().split(/\s+/)) {
    if (word.startsWith("project:")) {
      const project = word.slice(8).toLowerCase();
      candidates = candidates.filter((s) => s.workspace.toLowerCase().includes(project));
    } else if (/^(after|before):/.test(word)) {
      const [kind, date] = word.split(":");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return [];
      const boundary = Date.parse(date) + (kind === "before" ? 86400000 - 1 : 0);
      candidates = candidates.filter((s) => kind === "after" ? s.modified.getTime() >= boundary : s.modified.getTime() <= boundary);
    } else text.push(word);
  }
  return fuzzyFilter(candidates, text.join(" "), (s) => `${sessionTitle(s)} ${s.workspace} ${s.modified.toISOString()}${content ? ` ${s.allMessagesText}` : ""}`);
}
