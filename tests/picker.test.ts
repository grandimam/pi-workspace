import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { WorkspacePicker } from "../src/picker.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;

test("picker fits its available width and height, including long Unicode paths", () => {
  const picker = new WorkspacePicker(theme, () => 14, () => {}, () => {});
  picker.setItems(Array.from({ length: 100 }, (_, i) => ({
    path: `/projects/${"文".repeat(70)}/${i}`, name: "文".repeat(70), modified: 0,
  })));
  for (const width of [6, 12, 36]) {
    const lines = picker.render(width);
    assert.ok(lines.length <= 14);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  assert.deepEqual(picker.render(1), []);
});

test("typing filters names and paths; arrows navigate; no matches cannot select", () => {
  const picker = new WorkspacePicker(theme, () => 24, () => {}, () => {});
  picker.activePath = "/a";
  picker.setItems([
    { path: "/a", name: "alpha", modified: 1 },
    { path: "/projects/b", name: "beta", modified: 0 },
  ]);
  assert.equal(picker.selectedWorkspace?.name, "alpha");
  picker.handleInput("\x1b[B");
  assert.equal(picker.selectedWorkspace?.name, "beta");
  picker.handleInput("bt"); // fuzzy name matching
  assert.equal(picker.selectedWorkspace?.name, "beta");
  picker.handleInput("\x15"); // Ctrl+U
  picker.handleInput("projects"); // path matching
  assert.equal(picker.selectedWorkspace?.name, "beta");
  picker.handleInput("zzzz");
  assert.equal(picker.selectedWorkspace, undefined);
});

test("Escape and Ctrl+X close the picker; filtering never submits a selection", () => {
  let closed = 0;
  const picker = new WorkspacePicker(theme, () => 24, () => { closed++; }, () => {});
  picker.handleInput("\x1b");
  picker.handleInput("\x18");
  assert.equal(closed, 2);
  picker.handleInput("\r");
  assert.equal(closed, 2);
  picker.focused = true;
  assert.ok(picker.focused);
});

test("Add appears above projects without changing the default workspace selection", () => {
  let rows = 24;
  const picker = new WorkspacePicker(theme, () => rows, () => {}, () => {});
  picker.configureAdd("/", async (path) => path);
  picker.setItems([
    { path: "/alpha", name: "alpha", modified: 1 },
    { path: "/beta", name: "beta", modified: 0 },
  ]);
  const lines = picker.render(76);
  assert.ok(lines.findIndex((line) => line.includes("Add workspace")) < lines.findIndex((line) => line.includes("alpha")));
  assert.equal(picker.selectedWorkspace?.name, "alpha");
  picker.handleInput("\x1b[A"); // Up selects Add.
  assert.ok(picker.handlesEnter);
  rows = 18;
  picker.render(76); // Resizing preserves Add selection.
  assert.ok(picker.handlesEnter);
  picker.handleInput("\x1b[B");
  assert.equal(picker.selectedWorkspace?.name, "alpha");
  picker.handleInput("beta");
  assert.equal(picker.selectedWorkspace?.name, "beta");
});
