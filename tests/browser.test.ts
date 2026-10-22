import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DirectoryBrowser } from "../src/directory-browser.ts";
import { WorkspacePicker } from "../src/picker.ts";
const theme = { fg: (_color: string, text: string) => text } as Theme;

test("browsing and editing paths do not register until explicitly confirmed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-browser-")));
  let registered = "";
  let back = false;
  await mkdir(join(root, "child"));
  const browser = new DirectoryBrowser(theme, () => 18, root, () => { back = true; }, async (path) => { registered = path; }, () => {});
  try {
    await browser.navigate(root);
    browser.handleInput("\t"); // edit path
    browser.handleInput("\x15");
    browser.handleInput(join(root, "child"));
    browser.handleInput("\r"); // browse, not add
    for (let i = 0; i < 100 && browser.path !== join(root, "child"); i++) await setTimeout(10);
    assert.equal(browser.path, join(root, "child"));
    assert.equal(registered, "");
    for (const width of [16, 40]) {
      const lines = browser.render(width);
      assert.ok(lines.length <= 18);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    browser.handleInput("\x01"); // explicit Ctrl+A add
    await setTimeout(0);
    assert.equal(registered, join(root, "child"));
    browser.handleInput("\x1b");
    assert.ok(back);
  } finally { browser.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Add remains available with no search matches, and Escape returns to the picker", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-picker-add-")));
  const picker = new WorkspacePicker(theme, () => 24, () => {}, () => {});
  picker.configureAdd(root, async () => { throw new Error("must not save on cancel"); });
  try {
    picker.handleInput("nomatch");
    assert.ok(picker.handlesEnter);
    picker.handleInput("\r");
    assert.ok(picker.render(70).some((line) => line.includes("Add workspace")));
    picker.handleInput("\x1b");
    assert.ok(picker.render(70).some((line) => line.includes("Switch workspace")));
    assert.equal(picker.selectedWorkspace, undefined);
  } finally { picker.dispose(); await rm(root, { recursive: true, force: true }); }
});
