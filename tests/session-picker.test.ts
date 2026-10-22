import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { WorkspacePicker } from "../src/picker.ts";
import { parseState } from "../src/state.ts";
import type { WorkspaceSession } from "../src/sessions.ts";
const theme = { fg: (_: string, value: string) => value } as Theme;
const session = (path: string, name: string, workspace = "/code/a"): WorkspaceSession => ({
  id: path, path, name, cwd: workspace, workspace, firstMessage: "", allMessagesText: "", messageCount: 0,
  created: new Date("2026-01-01"), modified: new Date("2026-02-01"),
});

test("workspace selection opens sessions, Continue prefers remembered session, New has no parent history", () => {
  const picker = new WorkspacePicker(theme, () => 24, () => {}, () => {});
  picker.setItems([{ path: "/code/a", name: "a", modified: 0 }]);
  const state = parseState(undefined);
  state.sessions["/code/a"] = "/sessions/older";
  picker.setSessions([session("/sessions/latest", "Latest"), session("/sessions/older", "Older")], state);
  assert.equal(picker.selectedTarget, undefined);
  picker.handleInput("\r");
  assert.deepEqual(picker.selectedTarget, { workspace: "/code/a", file: "/sessions/older" });
  picker.handleInput("\x1b[B");
  assert.deepEqual(picker.selectedTarget, { workspace: "/code/a", create: true });
  picker.handleInput("\x1b");
  assert.equal(picker.selectedWorkspace?.path, "/code/a");
});

test("no-session project offers New; stale remembered pointer falls back to latest", () => {
  const picker = new WorkspacePicker(theme, () => 24, () => {}, () => {});
  picker.setItems([{ path: "/code/a", name: "a", modified: 0 }]);
  picker.handleInput("\r");
  assert.deepEqual(picker.selectedTarget, { workspace: "/code/a", create: true });
  picker.handleInput("\x1b");
  const state = parseState(undefined); state.sessions["/code/a"] = "/missing";
  picker.setSessions([session("/sessions/latest", "Latest")], state);
  picker.handleInput("\r");
  assert.deepEqual(picker.selectedTarget, { workspace: "/code/a", file: "/sessions/latest" });
});

test("global session search opens the chosen project's actual session", () => {
  const picker = new WorkspacePicker(theme, () => 24, () => {}, () => {});
  picker.configureNavigation({ pickerShortcut: "ctrl+x", contentSearch: false, pin: async () => {}, discover: async () => {} });
  picker.setSessions([session("/sessions/a", "Auth review"), session("/sessions/b", "Benchmark", "/code/b")], parseState(undefined));
  picker.handleInput("\x13"); // Ctrl+S
  picker.handleInput("project:b Benchmark");
  assert.deepEqual(picker.selectedTarget, { workspace: "/code/b", file: "/sessions/b" });
});
