import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { expandPath, readRegistry, registerDirectory } from "../src/registry.ts";
import { childDirectories, completeDirectory } from "../src/directories.ts";
import { collectWorkspaces } from "../src/workspaces.ts";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-registry-")));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("registration persists, canonicalizes symlinks, deduplicates, and merges with sessions", () => fixture(async (root) => {
  const directory = join(root, "my project");
  await mkdir(directory);
  await symlink(directory, join(root, "alias"));
  const registry = join(root, "agent", "workspaces.json");
  assert.deepEqual(await readRegistry(registry), []);
  assert.equal(await registerDirectory(registry, "my project", root), directory);
  await registerDirectory(registry, "alias", root);
  assert.deepEqual(await readRegistry(registry), [directory]);
  const workspaces = await collectWorkspaces([], root, await readRegistry(registry));
  assert.equal(workspaces.find((w) => w.path === directory)?.sessionFile, undefined);
  const merged = await collectWorkspaces([{ cwd: directory, path: "session.jsonl", modified: new Date() }], root, [directory]);
  assert.equal(merged.filter((w) => w.path === directory).length, 1);
  assert.equal(merged.find((w) => w.path === directory)?.sessionFile, "session.jsonl");
  assert.equal((await stat(registry)).mode & 0o777, 0o600);
}));

test("concurrent writers preserve both registrations", () => fixture(async (root) => {
  await mkdir(join(root, "a")); await mkdir(join(root, "b"));
  const registry = join(root, "workspaces.json");
  await Promise.all([registerDirectory(registry, "a", root), registerDirectory(registry, "b", root)]);
  assert.deepEqual((await readRegistry(registry)).sort(), [join(root, "a"), join(root, "b")]);
}));

test("missing paths, files, and malformed registries fail without replacing data", () => fixture(async (root) => {
  const registry = join(root, "workspaces.json");
  await writeFile(registry, "broken json");
  await assert.rejects(registerDirectory(registry, root, root));
  assert.equal(await readFile(registry, "utf8"), "broken json");
  await assert.rejects(registerDirectory(registry, "missing", root));
  await assert.rejects(registerDirectory(registry, registry, root), /directory/);
}));

test("browser lists only usable directories and completes space-containing paths", () => fixture(async (root) => {
  await mkdir(join(root, "my project")); await mkdir(join(root, "more"));
  await writeFile(join(root, "file"), "hello");
  await symlink(join(root, "missing"), join(root, "broken"));
  await symlink(root, join(root, "loop"));
  assert.deepEqual(await childDirectories(root), ["loop", "more", "my project"]);
  assert.deepEqual(await completeDirectory("my", root), { value: join(root, "my project") + "/", count: 1 });
  assert.equal((await completeDirectory("m", root)).count, 2);
  assert.equal((await completeDirectory("nothing", root)).count, 0);
  assert.equal(expandPath("~/code", root), join(homedir(), "code"));
  assert.equal(expandPath("~", root), homedir());
}));
