import { access, open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type OverlayHandle } from "@earendil-works/pi-tui";
import { WorkspacePanel } from "./panel.ts";
import { collectWorkspaces, type Workspace } from "./workspaces.ts";

export default function workspaceExtension(pi: ExtensionAPI) {
  let handle: OverlayHandle | undefined;
  let panel: WorkspacePanel | undefined;
  let close: (() => void) | undefined;
  let removeInputListener: (() => void) | undefined;
  let redraw = () => {};
  let stopped = false;
  let loading = false;
  let switching = false;
  let pending: Workspace | undefined;

  async function refresh(ctx: ExtensionContext) {
    if (loading || stopped) return;
    loading = true;
    try {
      const cwd = ctx.cwd;
      const active = await realpath(cwd);
      const items = await collectWorkspaces(await SessionManager.listAll(), cwd);
      if (stopped || !panel) return;
      panel.activePath = active;
      panel.items = items;
      panel.message = `${items.length} projects · ● active`;
      redraw();
    } catch (error) {
      if (!stopped && panel) {
        panel.message = "Unable to list sessions";
        ctx.ui.notify(`Workspace: ${String(error)}`, "error");
        redraw();
      }
    } finally { loading = false; }
  }

  function toggle() {
    if (!handle) return;
    if (!handle.isHidden()) handle.unfocus();
    handle.setHidden(!handle.isHidden());
    redraw();
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    function prepareSelection(workspace: Workspace): boolean {
      if (switching || pending || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait for the agent to finish before switching workspaces.", "warning");
        return false;
      }
      if (workspace.path === panel?.activePath) { handle?.unfocus(); return false; }
      if (!workspace.sessionFile) return false;
      if (ctx.ui.getEditorText().trim()) {
        ctx.ui.notify("Submit or clear your draft before switching workspaces.", "warning");
        return false;
      }
      pending = workspace;
      handle?.unfocus();
      ctx.ui.setEditorText("/workspace-open");
      return true;
    }
    // Forward the user's Enter to the editor's normal command pipeline. In Pi
    // 0.80.6 sendUserMessage skips command dispatch and would send this to the LLM.
    // No synthetic prompts, retained command contexts, or private runtime APIs.
    removeInputListener = ctx.ui.onTerminalInput((data) => {
      if (!handle?.isFocused() || !matchesKey(data, "enter")) return;
      const workspace = panel?.items[panel.selected];
      if (!workspace || !prepareSelection(workspace)) return { consume: true };
      return { data: "\r" };
    });
    // Do not await this promise: the overlay lives for the entire session.
    void ctx.ui.custom<void>((tui, theme, _keys, done) => {
      close = () => done();
      redraw = () => tui.requestRender();
      panel = new WorkspacePanel(
        theme,
        () => tui.terminal.rows,
        (workspace) => { prepareSelection(workspace); },
        () => handle?.unfocus(),
        toggle,
        () => { void refresh(ctx); },
        redraw,
      );
      if (stopped) queueMicrotask(() => done());
      else void refresh(ctx);
      return panel;
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "top-right",
        width: 36,
        maxHeight: "100%",
        nonCapturing: true,
        visible: (width, height) => width >= 80 && height >= 14,
      },
      onHandle: (next) => { handle = next; },
    }).catch((error) => {
      if (!stopped) ctx.ui.notify(`Workspace panel: ${String(error)}`, "error");
    });
  });

  pi.registerShortcut("alt+w", {
    description: "Focus workspace panel",
    handler: (ctx) => {
      if (ctx.mode !== "tui" || !handle) return;
      handle.setHidden(false);
      if (handle.isFocused()) handle.unfocus(); else handle.focus();
      redraw();
    },
  });
  pi.registerShortcut("alt+shift+w", {
    description: "Hide/show workspace panel",
    handler: () => toggle(),
  });

  pi.registerCommand("workspace-open", {
    description: "Internal workspace-panel selection (use Alt+W)",
    handler: async (_args, ctx) => {
      const destination = pending;
      pending = undefined;
      if (!destination?.sessionFile || switching) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait for the agent to finish before switching workspaces.", "warning");
        return;
      }
      switching = true;
      try {
        const path = await realpath(destination.path);
        if (!(await stat(path)).isDirectory()) throw new Error("Workspace is not a directory");
        await access(path, constants.R_OK | constants.X_OK);
        // Validate ownership without SessionManager.open's migration/write side effects.
        const file = await open(destination.sessionFile, "r");
        let header: { type?: string; cwd?: string };
        try {
          const buffer = Buffer.alloc(65536);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const text = buffer.toString("utf8", 0, bytesRead);
          const end = text.indexOf("\n");
          if (end < 0) throw new Error("Invalid session header");
          header = JSON.parse(text.slice(0, end));
        } finally { await file.close(); }
        if (header.type !== "session" || !header.cwd || await realpath(header.cwd) !== path) {
          throw new Error("Session does not belong to the selected workspace");
        }
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Agent is busy; try again when idle");
        const result = await ctx.switchSession(destination.sessionFile, {
          withSession: async (fresh) => {
            const expected = await realpath(path);
            const actual = await realpath(fresh.cwd);
            const sessionCwd = await realpath(fresh.sessionManager.getCwd());
            const promptCwd = fresh.getSystemPromptOptions().cwd;
            if (actual !== expected || sessionCwd !== expected || !promptCwd || await realpath(promptCwd) !== expected) {
              // The host treats a callback failure as fatal, preventing mixed-context execution.
              throw new Error("Workspace context verification failed");
            }
          },
        });
        if (result.cancelled) ctx.ui.notify("Workspace switch cancelled", "info");
      } catch (error) {
        if (!stopped) ctx.ui.notify(`Workspace switch failed: ${String(error)}`, "error");
      } finally { switching = false; }
    },
  });

  pi.on("session_shutdown", () => {
    stopped = true;
    pending = undefined;
    removeInputListener?.();
    close?.();
    handle = undefined;
    panel = undefined;
  });
}
