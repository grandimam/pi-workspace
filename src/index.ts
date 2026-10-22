import { access, open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type OverlayHandle } from "@earendil-works/pi-tui";
import { WorkspacePicker } from "./picker.ts";
import { collectWorkspaces, displayText, type Workspace } from "./workspaces.ts";
import { readRegistry, registerDirectory } from "./registry.ts";

export default function workspaceExtension(pi: ExtensionAPI) {
  let handle: OverlayHandle | undefined;
  let picker: WorkspacePicker | undefined;
  let close: (() => void) | undefined;
  let removeInputListener: (() => void) | undefined;
  let redraw = () => {};
  let stopped = false;
  let refreshTask: Promise<void> | undefined;
  const registryFile = join(getAgentDir(), "workspaces.json");
  let switching = false;
  let pending: Workspace | undefined;
  let items: Workspace[] = [];
  let activePath = "";
  let message = "Loading projects…";

  function updatePicker() {
    if (!picker) return;
    picker.activePath = activePath;
    picker.setItems(items);
    picker.message = message;
    redraw();
  }

  function refresh(ctx: ExtensionContext): Promise<void> {
    if (refreshTask) return refreshTask;
    if (stopped) return Promise.resolve();
    refreshTask = (async () => {
      try {
        const cwd = ctx.cwd;
        const active = await realpath(cwd);
        const next = await collectWorkspaces(await SessionManager.listAll(), cwd, await readRegistry(registryFile));
        if (stopped) return;
        activePath = active;
        items = next;
        message = `${items.length} projects · recent sessions · ● active`;
      } catch (error) {
        if (!stopped) message = `Cannot load workspaces: ${String(error)}`;
      } finally {
        if (!stopped) updatePicker();
      }
    })().finally(() => { refreshTask = undefined; });
    return refreshTask;
  }

  function showPicker(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || stopped) return;
    if (close) { close(); return; }
    // Reserve the open state immediately, including while the factory is mounting.
    let done: (() => void) | undefined;
    let columns = () => 80;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      done?.();
      if (close === finish) {
        close = undefined;
        picker = undefined;
        handle = undefined;
        redraw = () => {};
      }
    };
    close = finish;
    void ctx.ui.custom<void>((tui, theme, _keys, resolve) => {
      done = () => resolve();
      columns = () => tui.terminal.columns;
      if (stopped || close !== finish) queueMicrotask(done);
      redraw = () => tui.requestRender();
      const component = new WorkspacePicker(theme, () => Math.floor(tui.terminal.rows * 0.8), finish, redraw);
      picker = component;
      component.configureAdd(dirname(ctx.cwd), async (path) => {
        // Drain any older refresh before writing, then reload the merged index.
        await refresh(ctx);
        if (stopped) throw new Error("Session closed; reopen the workspace picker");
        const added = await registerDirectory(registryFile, path, ctx.cwd);
        await refresh(ctx);
        return added;
      });
      updatePicker();
      void refresh(ctx);
      return component;
    }, {
      overlay: true,
      overlayOptions: () => ({
        anchor: "center", width: Math.min(76, Math.max(1, columns() - 4)), maxHeight: "80%", margin: 1,
      }),
      onHandle: (next) => { if (close === finish) handle = next; },
    }).catch((error) => {
      if (!stopped) ctx.ui.notify(`Workspace picker: ${String(error)}`, "error");
    }).finally(finish);
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("workspace", `● ${displayText(basename(ctx.cwd) || ctx.cwd)} · Ctrl+X`);
    void refresh(ctx);
    // Forward the user's Enter through Pi's normal command pipeline. In Pi
    // 0.80.6 sendUserMessage skips command dispatch and would send it to the LLM.
    removeInputListener = ctx.ui.onTerminalInput((data) => {
      if (!handle?.isFocused() || !matchesKey(data, "enter")) return;
      if (picker?.handlesEnter) return; // Browser and Add actions own their Enter key.
      const workspace = picker?.selectedWorkspace;
      if (!workspace) return { consume: true };
      if (workspace.path === activePath) { close?.(); return { consume: true }; }
      if (switching || pending || !ctx.isIdle() || ctx.hasPendingMessages()) {
        if (picker) picker.message = "Wait for the agent to finish before switching";
        redraw();
        return { consume: true };
      }
      if (!workspace.sessionFile) {
        if (picker) picker.message = "No session yet. Start Pi in this directory and save a conversation first.";
        redraw();
        return { consume: true };
      }
      if (ctx.ui.getEditorText().trim()) {
        if (picker) picker.message = "Submit or clear your draft before switching";
        redraw();
        return { consume: true };
      }
      pending = workspace;
      close?.(); // Synchronously restores editor focus before Enter is forwarded.
      ctx.ui.setEditorText("/workspace-open");
      return { data: "\r" };
    });
  });

  for (const shortcut of ["ctrl+x", "alt+w"] as const) {
    pi.registerShortcut(shortcut, {
      description: "Open workspace quick switcher",
      handler: (ctx) => showPicker(ctx),
    });
  }

  pi.registerCommand("workspace-open", {
    description: "Internal workspace selection (use Ctrl+X)",
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

  pi.on("session_shutdown", (_event, ctx) => {
    stopped = true;
    pending = undefined;
    removeInputListener?.();
    close?.();
    if (ctx.mode === "tui") ctx.ui.setStatus("workspace", undefined);
  });
}
