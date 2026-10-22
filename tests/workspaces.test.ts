import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectWorkspaces, displayText } from "../src/workspaces.ts";

test("canonical paths deduplicate aliases; newest session wins; active project is first", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-workspace-")));
  try {
    const a = join(root, "a");
    const b = join(root, "b");
    const alias = join(root, "alias");
    await mkdir(a); await mkdir(b); await symlink(b, alias);
    const items = await collectWorkspaces([
      { cwd: b, path: "old.jsonl", modified: new Date(100) },
      { cwd: alias, path: "new.jsonl", modified: new Date(200) },
      { cwd: join(root, "missing"), path: "gone.jsonl", modified: new Date(300) },
    ], a);
    assert.equal(items.length, 2);
    assert.equal(items[0].path, a);
    assert.equal(items[0].sessionFile, undefined);
    assert.equal(items[1].path, b);
    assert.equal(items[1].sessionFile, "new.jsonl");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("display metadata cannot inject terminal control characters", () => {
  assert.equal(displayText("hello\x1b[2J\nworld"), "hello?[2J?world");
});
