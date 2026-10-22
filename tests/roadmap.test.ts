import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepositories } from "../src/discovery.ts";
import { defaults, readConfig } from "../src/config.ts";
import { changeState, previousWorkspace, readState, recordAccess } from "../src/state.ts";
import { searchSessions, type WorkspaceSession } from "../src/sessions.ts";
import { gitBranch } from "../src/status.ts";
import { execFileSync } from "node:child_process";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-roadmap-")));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("discovery handles nested repositories, worktree markers, ignored dirs, aliases, depth and cancellation", () => fixture(async (root) => {
  const a = join(root, "a"), nested = join(a, "nested"), worktree = join(root, "worktree");
  await mkdir(join(a, ".git"), { recursive: true });
  await mkdir(join(nested, ".git"), { recursive: true });
  await mkdir(worktree); await writeFile(join(worktree, ".git"), "gitdir: ../a/.git/worktrees/test\n");
  await mkdir(join(root, "node_modules", "ignored", ".git"), { recursive: true });
  await symlink(root, join(a, "loop"));
  await symlink(a, join(root, "alias"));
  const config = { ...defaults, roots: [root, a], maxDepth: 2 };
  assert.deepEqual((await discoverRepositories(config)).paths, [a, nested, worktree].sort());
  assert.deepEqual((await discoverRepositories({ ...config, roots: [root], maxDepth: 1 })).paths, [a, worktree].sort());
  assert.deepEqual((await discoverRepositories({ ...config, roots: [a], maxDepth: 0 })).paths, [a]);
  assert.equal((await discoverRepositories({ ...config, roots: [join(root, "gone")] })).warnings.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverRepositories(config, controller.signal));
}));

test("pins, session pointers and navigation persist; previous toggles A ↔ B without duplicates", () => fixture(async (root) => {
  const file = join(root, "state.json"), a = join(root, "a"), b = join(root, "b");
  await changeState(file, (state) => { state.pinned.push(a); recordAccess(state, a, "/sessions/a.jsonl"); });
  await changeState(file, (state) => recordAccess(state, b, "/sessions/b.jsonl"));
  let state = await readState(file);
  assert.equal(previousWorkspace(state, b), a);
  await changeState(file, (state) => recordAccess(state, a, "/sessions/a2.jsonl"));
  state = await readState(file);
  assert.equal(previousWorkspace(state, a), b);
  assert.deepEqual(state.recent, [a, b]);
  assert.deepEqual(state.pinned, [a]);
  assert.equal(state.sessions[a], "/sessions/a2.jsonl");
  await assert.rejects(changeState(file, () => { throw new Error("cancel"); }));
  assert.deepEqual(await readState(file), state);
}));

const sessions: WorkspaceSession[] = [
  { id: "1", path: "/sessions/1", cwd: "/code/a", workspace: "/code/a", name: "Auth middleware", firstMessage: "", allMessagesText: "secretcontentonly", created: new Date("2026-01-01"), modified: new Date("2026-01-02T20:00Z"), messageCount: 1 },
  { id: "2", path: "/sessions/2", cwd: "/code/b", workspace: "/code/b", name: "Fix tests", firstMessage: "", allMessagesText: "", created: new Date("2026-02-01"), modified: new Date("2026-02-03"), messageCount: 1 },
];
test("global session search filters project and inclusive UTC dates; content is opt-in", () => {
  assert.equal(searchSessions(sessions, "Auth project:a after:2026-01-01 before:2026-01-02")[0].id, "1");
  assert.deepEqual(searchSessions(sessions, "Auth project:b"), []);
  assert.deepEqual(searchSessions(sessions, "after:not-a-date"), []);
  assert.deepEqual(searchSessions(sessions, "after:2026-02-30"), []);
  assert.deepEqual(searchSessions(sessions, "secretcontentonly"), []);
  assert.equal(searchSessions(sessions, "secretcontentonly", true)[0].id, "1");
});

test("config validates shortcuts/depth and status reads Git branch without mutation", () => fixture(async (root) => {
  const file = join(root, "config.json");
  assert.equal((await readConfig(file)).previousShortcut, "ctrl+alt+p");
  await writeFile(file, JSON.stringify({ maxDepth: -1 }));
  await assert.rejects(readConfig(file), /maxDepth/);
  await writeFile(file, JSON.stringify({ pickerShortcut: "x" }));
  await assert.rejects(readConfig(file), /typing/);
  await writeFile(file, JSON.stringify({ pickerShortcut: "ctrl+j", showStatus: false }));
  assert.equal((await readConfig(file)).showStatus, false);
  execFileSync("git", ["init", "-b", "workspace-test", root], { stdio: "ignore" });
  assert.equal(await gitBranch(root), "workspace-test");
}));
