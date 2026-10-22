import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import type { WorkspacePicker } from "../src/picker.ts";

test("startup shows only a footer; shortcut opens picker; Escape closes; reopen and shutdown clean up", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temporary;
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>>();
  const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => void }>();
  const original = SessionManager.listAll;
  SessionManager.listAll = async () => [];
  let component: WorkspacePicker | undefined;
  let closed = 0;
  let opened = 0;
  let status: string | undefined;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
    registerShortcut: (name: string, options: { handler: (ctx: ExtensionContext) => void }) => shortcuts.set(name, options),
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(), mode: "tui",
    sessionManager: { getCwd: () => process.cwd(), getSessionFile: () => undefined },
    ui: {
      setStatus: (_key: string, value: string | undefined) => { status = value; },
      notify: () => {},
      onTerminalInput: () => () => {},
      custom: (factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => WorkspacePicker,
        opts: { overlay: boolean; overlayOptions: () => Record<string, unknown> }) => {
        opened++;
        assert.equal(opts.overlay, true);
        assert.equal(opts.overlayOptions().anchor, "center");
        assert.notEqual(opts.overlayOptions().nonCapturing, true);
        assert.ok(Number(opts.overlayOptions().width) <= 88);
        return new Promise<void>((resolve) => {
          component = factory(
            { terminal: { rows: 24, columns: 110 }, requestRender: () => {} } as unknown as TUI,
            { fg: (_key: string, text: string) => text } as Theme,
            undefined, () => { closed++; resolve(); },
          );
        });
      },
    },
  } as unknown as ExtensionContext;
  try {
    await extension(pi);
    await handlers.get("session_start")!({}, ctx);
    assert.equal(opened, 0, "No overlay at startup");
    assert.ok(status?.includes("Ctrl+X"));
    shortcuts.get("ctrl+x")!.handler(ctx);
    for (let i = 0; i < 100 && !component?.selectedWorkspace; i++) await setTimeout(10);
    assert.ok(component?.selectedWorkspace);
    component.handleInput("\x1b");
    await setTimeout(0);
    assert.equal(closed, 1);
    shortcuts.get("ctrl+x")!.handler(ctx);
    assert.equal(opened, 2);
    await handlers.get("session_shutdown")!({}, ctx);
    assert.equal(status, undefined);
    assert.equal(closed, 2);
  } finally {
    SessionManager.listAll = original;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
});
