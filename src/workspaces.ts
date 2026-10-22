import { realpath } from "node:fs/promises";
import { basename } from "node:path";

export interface Workspace {
  path: string;
  name: string;
  sessionFile?: string;
  modified: number;
}

interface SessionRecord {
  cwd: string;
  path: string;
  modified: Date;
}

// No repository scanning or code execution: use Pi's existing session index.
export async function collectWorkspaces(
  sessions: SessionRecord[],
  cwd: string,
): Promise<Workspace[]> {
  const active = await realpath(cwd);
  const entries = new Map<string, Workspace>();
  entries.set(active, { path: active, name: basename(active) || active, modified: 0 });
  for (const session of sessions) {
    let path: string;
    try { path = await realpath(session.cwd); } catch { continue; }
    const modified = session.modified.getTime();
    const previous = entries.get(path);
    if (!previous?.sessionFile || modified > previous.modified) {
      entries.set(path, { path, name: basename(path) || path, sessionFile: session.path, modified });
    }
  }
  return [...entries.values()].sort((a, b) =>
    Number(b.path === active) - Number(a.path === active) || b.modified - a.modified || a.path.localeCompare(b.path),
  );
}

// Paths and session metadata must not inject terminal control sequences.
export function displayText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
}
