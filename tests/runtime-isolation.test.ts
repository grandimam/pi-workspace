import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory, type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createWorkspaceSession, validateSession } from "../src/sessions.ts";
import { switchWorkspace } from "../src/switcher.ts";

test("real runtime A → B → A rebuilds instructions, settings, skills, extensions and actual filesystem tools", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-runtime-")));
  const agentDir = join(root, "agent");
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  try {
    const dirs = [join(root, "a"), join(root, "b")];
    const files: string[] = [];
    for (const [index, cwd] of dirs.entries()) {
      const label = index === 0 ? "A" : "B";
      await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
      await mkdir(join(cwd, ".pi", "skills", `skill-${label.toLowerCase()}`), { recursive: true });
      await writeFile(join(cwd, "AGENTS.md"), `UNIQUE_INSTRUCTIONS_${label}`);
      await writeFile(join(cwd, "marker.txt"), label);
      await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: index === 0 ? "low" : "high" }));
      await writeFile(join(cwd, ".pi", "extensions", `local-${label}.ts`), `export default function(pi) { pi.registerCommand('only-${label}', {handler: async () => {}}); }`);
      await writeFile(join(cwd, ".pi", "skills", `skill-${label.toLowerCase()}`, "SKILL.md"), `---\nname: skill-${label.toLowerCase()}\ndescription: Local ${label} skill\n---\nUse ${label}.`);
      const file = await createWorkspaceSession(cwd, join(agentDir, "sessions", label));
      SessionManager.open(file).appendMessage({ role: "user", content: `HISTORY_${label}`, timestamp: Date.now() });
      files.push(file);
    }
    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd, agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
        resourceLoaderOptions: { noPromptTemplates: true },
      });
      const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ["read", "write", "edit", "bash"] });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    runtime = await createAgentSessionRuntime(factory, { cwd: dirs[0], agentDir, sessionManager: SessionManager.open(files[0]) });
    for (const index of [0, 1, 0]) {
      if (runtime.session.sessionFile !== files[index]) await runtime.switchSession(files[index]);
      const label = index === 0 ? "A" : "B";
      const other = index === 0 ? "B" : "A";
      assert.equal(runtime.cwd, dirs[index]);
      assert.equal(runtime.session.sessionManager.getCwd(), dirs[index]);
      assert.ok(runtime.session.systemPrompt.includes(`UNIQUE_INSTRUCTIONS_${label}`));
      assert.ok(!runtime.session.systemPrompt.includes(`UNIQUE_INSTRUCTIONS_${other}`));
      assert.equal(runtime.services.settingsManager.getDefaultThinkingLevel(), index === 0 ? "low" : "high");
      assert.ok(runtime.services.resourceLoader.getSkills().skills.some((s) => s.name === `skill-${label.toLowerCase()}`));
      assert.ok(!runtime.services.resourceLoader.getSkills().skills.some((s) => s.name === `skill-${other.toLowerCase()}`));
      const extensions = runtime.services.resourceLoader.getExtensions();
      assert.deepEqual(extensions.errors, []);
      assert.ok(extensions.extensions.some((e) => e.path.endsWith(`local-${label}.ts`)));
      assert.ok(!extensions.extensions.some((e) => e.path.endsWith(`local-${other}.ts`)));
      const history = JSON.stringify(runtime.session.messages);
      assert.ok(history.includes(`HISTORY_${label}`));
      assert.ok(!history.includes(`HISTORY_${other}`));
      // These are the live runtime's tools, NOT independently constructed tool factories.
      const run = async (name: string, args: Record<string, unknown>) => {
        const tool = runtime!.session.agent.state.tools.find((t) => t.name === name);
        assert.ok(tool, name);
        const result = await tool.execute(`test-${name}`, args as never, new AbortController().signal);
        return result.content.map((c) => c.type === "text" ? c.text : "").join("\n");
      };
      assert.ok((await run("read", { path: "marker.txt" })).includes(label));
      assert.equal(await realpath((await run("bash", { command: "pwd" })).trim()), dirs[index]);
      await run("write", { path: `only-${label}.txt`, content: "before" });
      await run("edit", { path: `only-${label}.txt`, edits: [{ oldText: "before", newText: "after" }] });
      assert.equal(await readFile(join(dirs[index], `only-${label}.txt`), "utf8"), "after");
      await assert.rejects(readFile(join(dirs[1 - index], `only-${label}.txt`)), { code: "ENOENT" });
    }
    assert.equal(runtime.session.sessionFile, files[0]);
  } finally { await runtime?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("empty-workspace sessions have only a header; invalid ownership and busy races never replace runtime", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-switch-")));
  try {
    const a = join(root, "a"), b = join(root, "b");
    await mkdir(a); await mkdir(b);
    const file = await createWorkspaceSession(b, join(root, "sessions"));
    const header = JSON.parse((await readFile(file, "utf8")).trim());
    assert.equal(header.cwd, b); assert.equal(header.type, "session");
    assert.equal(SessionManager.open(file).getEntries().length, 0);
    await validateSession(file, b);
    await assert.rejects(validateSession(file, a), /belong/);
    let replacements = 0;
    let idleCalls = 0;
    const ctx = { cwd: a, isIdle: () => ++idleCalls === 1, hasPendingMessages: () => false,
      switchSession: async () => { replacements++; return { cancelled: false }; },
    } as unknown as ExtensionCommandContext;
    await assert.rejects(switchWorkspace(ctx, { workspace: b, file }), /Wait/);
    assert.equal(replacements, 0);
    await writeFile(join(root, "bad.jsonl"), "not a session\n");
    await assert.rejects(validateSession(join(root, "bad.jsonl"), b));
    await assert.rejects(validateSession(join(root, "gone.jsonl"), b));
  } finally { await rm(root, { recursive: true, force: true }); }
});
