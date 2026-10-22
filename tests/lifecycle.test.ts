import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import type { WorkspacePanel } from "../src/panel.ts";

test("startup opens a non-capturing right overlay without a command; shutdown closes it", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const original = SessionManager.listAll;
  SessionManager.listAll = async () => [];
  let component: WorkspacePanel | undefined;
  let closed = false;
  let options: Record<string, unknown> | undefined;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
    registerShortcut: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(), mode: "tui",
    ui: {
      notify: () => {},
      onTerminalInput: () => () => {},
      custom: (factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => WorkspacePanel,
        opts: { overlay: boolean; overlayOptions: Record<string, unknown> }) => {
        assert.equal(opts.overlay, true);
        options = opts.overlayOptions;
        return new Promise<void>((resolve) => {
          component = factory(
            { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI,
            { fg: (_key: string, text: string) => text } as Theme,
            undefined, () => { closed = true; resolve(); },
          );
        });
      },
    },
  } as unknown as ExtensionContext;
  try {
    extension(pi);
    const returned = handlers.get("session_start")!({}, ctx);
    assert.equal(returned, undefined, "startup must not wait for the overlay to close");
    assert.equal(options?.anchor, "top-right");
    assert.equal(options?.nonCapturing, true);
    for (let i = 0; i < 100 && component?.message === "Loading projects…"; i++) await setTimeout(10);
    assert.equal(component?.items.length, 1);
    handlers.get("session_shutdown")!({}, ctx);
    assert.ok(closed);
  } finally { SessionManager.listAll = original; }
});
