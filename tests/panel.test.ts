import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { WorkspacePanel } from "../src/panel.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;

test("panel fits terminal width and height, including long Unicode paths", () => {
  const panel = new WorkspacePanel(theme, () => 14, () => {}, () => {}, () => {}, () => {}, () => {});
  panel.items = Array.from({ length: 100 }, (_, i) => ({
    path: `/projects/${"文".repeat(70)}/${i}`, name: "文".repeat(70), modified: 0,
  }));
  for (const width of [4, 12, 36]) {
    const lines = panel.render(width);
    assert.ok(lines.length <= 14);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  assert.deepEqual(panel.render(1), []);
});

test("navigation selects a workspace and Escape returns focus without closing", () => {
  let selected = "";
  let released = false;
  let refreshed = false;
  const panel = new WorkspacePanel(theme, () => 24,
    (item) => { selected = item.path; }, () => { released = true; }, () => {},
    () => { refreshed = true; }, () => {});
  panel.items = ["/a", "/b"].map((path) => ({ path, name: path, modified: 0 }));
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  assert.equal(selected, "/b");
  panel.handleInput("\x1b");
  assert.ok(released);
  assert.equal(panel.items.length, 2);
  panel.handleInput("r");
  assert.ok(refreshed);
});
