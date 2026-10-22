import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type OverlayHandle } from "@earendil-works/pi-tui";
import { WorkspacePicker } from "./picker.ts";
import { collectWorkspaces, displayText, type Workspace } from "./workspaces.ts";
import { readRegistry, registerDirectory } from "./registry.ts";
import { defaults, readConfig } from "./config.ts";
import { changeState, parseState, previousWorkspace, readState, recordAccess } from "./state.ts";
import { discoverRepositories } from "./discovery.ts";
import { indexSessions, validateSession, type SessionTarget, type WorkspaceSession } from "./sessions.ts";
import { switchWorkspace } from "./switcher.ts";
import { gitBranch } from "./status.ts";

export default async function workspaceExtension(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const registryFile = join(agentDir, "workspaces.json");
  const stateFile = join(agentDir, "workspace-state.json");
  let config = { ...defaults };
  let configError: string | undefined;
  try { config = await readConfig(join(agentDir, "workspace-config.json")); }
  catch (error) { configError = String(error); }
  let state = parseState(undefined);
  let handle: OverlayHandle | undefined;
  let picker: WorkspacePicker | undefined;
  let close: (() => void) | undefined;
  let removeInputListener: (() => void) | undefined;
  let redraw = () => {};
  let stopped = false;
  let ready = false;
  let switching = false;
  let navigating = false;
  let pending: SessionTarget | undefined;
  let refreshTask: Promise<void> | undefined;
  let discovery: Promise<void> | undefined;
  const abortDiscovery = new AbortController();
  let items: Workspace[] = [];
  let sessions: WorkspaceSession[] = [];
  let activePath = "";
  let message = "Loading projects…";
  let branch: string | undefined;

  function status(ctx: ExtensionContext) {
    if (!config.showStatus) { ctx.ui.setStatus("workspace", undefined); return; }
    const count = sessions.filter((s) => s.workspace === activePath).length;
    const parts = [`● ${displayText(basename(ctx.cwd) || ctx.cwd)}`];
    if (config.showBranch && branch) parts.push(displayText(branch));
    if (config.showSessionCount) parts.push(`${count} session${count === 1 ? "" : "s"}`);
    parts.push(config.pickerShortcut.split("+").map((key) => key[0].toUpperCase() + key.slice(1)).join("+"));
    ctx.ui.setStatus("workspace", parts.join(" | "));
  }
  function updatePicker() {
    if (!picker) return;
    picker.activePath = activePath; picker.setItems(items); picker.setSessions(sessions, state);
    picker.message = message; redraw();
  }
  function refresh(ctx: ExtensionContext): Promise<void> {
    if (refreshTask) return refreshTask;
    if (stopped) return Promise.resolve();
    refreshTask = (async () => {
      try {
        const cwd = ctx.cwd;
        const active = await realpath(cwd);
        const nextState = await readState(stateFile);
        const raw = await SessionManager.listAll();
        const indexed = await indexSessions(raw);
        const paths = [...await readRegistry(registryFile), ...nextState.discovered];
        const next = await collectWorkspaces(raw, cwd, paths);
        const currentBranch = config.showBranch ? await gitBranch(cwd) : undefined;
        if (stopped) return;
        activePath = active; items = next; state = nextState; sessions = indexed; branch = currentBranch;
        message = `${items.length} projects · ★ pinned · ● active`;
      } catch (error) { if (!stopped) message = `Cannot load workspaces: ${String(error)}`; }
      finally { if (!stopped) { updatePicker(); status(ctx); } }
    })().finally(() => { refreshTask = undefined; });
    return refreshTask;
  }
  function scan(ctx: ExtensionContext): Promise<void> {
    if (discovery) return discovery;
    if (stopped) return Promise.resolve();
    message = "Discovering repositories…"; updatePicker();
    discovery = (async () => {
      try {
        const result = await discoverRepositories(config, abortDiscovery.signal);
        if (stopped) return;
        await refresh(ctx);
        if (stopped) return;
        await changeState(stateFile, (next) => { next.discovered = result.paths; });
        await refresh(ctx);
        message = config.roots.length ? `Found ${result.paths.length} repositories${result.warnings.length ? ` · ${result.warnings.length} inaccessible paths` : ""}` : "Set roots in workspace-config.json to enable discovery";
      } catch (error) { if (!stopped) message = `Discovery failed: ${String(error)}`; }
      finally { if (!stopped) updatePicker(); }
    })().finally(() => { discovery = undefined; });
    return discovery;
  }
  async function remember(ctx: ExtensionContext) {
    const cwd = ctx.cwd;
    const file = ctx.sessionManager.getSessionFile();
    const path = await realpath(cwd);
    state = await changeState(stateFile, (next) => recordAccess(next, path, file));
  }

  function showPicker(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || stopped) return;
    if (close) { close(); return; }
    let done: (() => void) | undefined;
    let columns = () => 80;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; done?.();
      if (close === finish) { close = undefined; picker = undefined; handle = undefined; redraw = () => {}; }
    };
    close = finish;
    void ctx.ui.custom<void>((tui, theme, _keys, resolve) => {
      done = () => resolve(); columns = () => tui.terminal.columns;
      if (stopped || close !== finish) queueMicrotask(done);
      redraw = () => tui.requestRender();
      const component = new WorkspacePicker(theme, () => Math.floor(tui.terminal.rows * 0.8), finish, redraw);
      picker = component;
      component.configureAdd(dirname(ctx.cwd), async (path) => {
        await refresh(ctx);
        if (stopped) throw new Error("Session closed; reopen the workspace picker");
        const added = await registerDirectory(registryFile, path, ctx.cwd);
        await refresh(ctx); return added;
      });
      component.configureNavigation({ pickerShortcut: config.pickerShortcut, contentSearch: config.contentSearch,
        pin: async (path) => {
          await refresh(ctx);
          if (stopped) return;
          await changeState(stateFile, (next) => {
            next.pinned = next.pinned.includes(path) ? next.pinned.filter((p) => p !== path) : [...next.pinned, path];
          });
          await refresh(ctx);
        }, discover: () => scan(ctx),
      });
      updatePicker(); void refresh(ctx); return component;
    }, { overlay: true,
      overlayOptions: () => ({ anchor: "center", width: Math.min(88, Math.max(1, columns() - 4)), maxHeight: "80%", margin: 1 }),
      onHandle: (next) => { if (close === finish) handle = next; },
    }).catch((error) => { if (!stopped) ctx.ui.notify(`Workspace picker: ${String(error)}`, "error"); }).finally(finish);
  }

  function allowed(ctx: ExtensionContext): boolean {
    const error = !ready ? "Workspace context is not ready; reload after correcting the error"
      : switching || pending || !ctx.isIdle() || ctx.hasPendingMessages() ? "Wait for the agent and queued messages to finish before switching"
      : ctx.ui.getEditorText().trim() ? "Submit or clear your draft before switching" : undefined;
    if (!error) return true;
    if (picker) { picker.message = error; redraw(); } else ctx.ui.notify(error, "warning");
    return false;
  }
  function dispatch(target: SessionTarget, ctx: ExtensionContext) {
    pending = target;
    close?.(); ctx.ui.setEditorText("/workspace-open");
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    status(ctx);
    if (configError) ctx.ui.notify(`Using default workspace settings: ${configError}`, "warning");
    try {
      activePath = await realpath(ctx.cwd);
      if (await realpath(ctx.sessionManager.getCwd()) !== activePath) throw new Error("Session and runtime cwd differ");
      ready = true;
      await remember(ctx);
    } catch (error) { ctx.ui.notify(`Workspace startup: ${String(error)}`, "error"); }
    void refresh(ctx).then(() => { if (!stopped && config.roots.length) void scan(ctx); });
    // User Enter (or the previous-workspace key) goes through the normal editor
    // command pipeline. sendUserMessage skips commands on Pi 0.80.6.
    removeInputListener = ctx.ui.onTerminalInput((data) => {
      if (matchesKey(data, config.previousShortcut)) {
        if (!allowed(ctx)) return { consume: true };
        const previous = previousWorkspace(state, activePath);
        if (!previous) { ctx.ui.notify("No previous workspace yet", "info"); return { consume: true }; }
        dispatch({ workspace: previous }, ctx);
        return { data: "\r" };
      }
      if (!handle?.isFocused() || !matchesKey(data, "enter")) return;
      const target = picker?.selectedTarget;
      if (!target) return; // Directory browser / workspace-to-session navigation own Enter.
      if (!allowed(ctx)) return { consume: true };
      dispatch(target, ctx); return { data: "\r" };
    });
  });

  pi.registerShortcut(config.pickerShortcut, { description: "Open workspace quick switcher", handler: showPicker });
  if (config.pickerShortcut !== "alt+w" && config.previousShortcut !== "alt+w") pi.registerShortcut("alt+w", { description: "Open workspace quick switcher", handler: showPicker });
  // Register for discoverability/conflict warnings; raw input dispatch owns this key.
  pi.registerShortcut(config.previousShortcut, { description: "Switch to previous workspace", handler: () => {} });

  // Block prompts and shell execution while asynchronous replacement is in flight.
  pi.on("input", (_event, ctx) => {
    if (ctx.mode === "tui" && (!ready || switching || navigating)) {
      ctx.ui.notify("Workspace transition in progress or context unavailable", "warning"); return { action: "handled" };
    }
  });
  pi.on("tool_call", (_event, ctx) => {
    if (ctx.mode === "tui" && (!ready || switching)) return { block: true, reason: "Workspace context unavailable or switching" };
  });
  pi.on("user_bash", (_event, ctx) => {
    if (ctx.mode === "tui" && (!ready || switching)) return { result: { output: "Workspace transition in progress", exitCode: 1, cancelled: false, truncated: false } };
  });
  pi.on("agent_settled", (_event, ctx) => { if (ctx.mode === "tui" && !stopped) void refresh(ctx); });

  pi.registerCommand("workspace-open", {
    description: "Internal workspace selection",
    handler: async (_args, ctx) => {
      const target = pending; pending = undefined;
      if (!target || switching || !ready) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("Agent is busy; switch cancelled", "warning"); return; }
      switching = true;
      try {
        await remember(ctx);
        // Previous-workspace navigation resolves the saved pointer, then falls
        // back to the newest valid session. Explicit selections never silently substitute.
        if (!target.file && !target.create) {
          navigating = true;
          const path = await realpath(target.workspace);
          const available = await indexSessions(await SessionManager.listAll());
          const candidates = [...new Set([state.sessions[path], ...available.filter((s) => s.workspace === path).map((s) => s.path)].filter((x): x is string => !!x))];
          for (const file of candidates) {
            try { await validateSession(file, path); target.file = file; break; } catch { /* stale saved reference */ }
          }
          if (!target.file) throw new Error("Previous workspace has no valid session; select New session from the picker");
        }
        const result = await switchWorkspace(ctx, target, async (fresh) => {
          // Successful runtime replacement is not undone for a metadata error.
          try {
            const path = await realpath(fresh.cwd);
            const file = fresh.sessionManager.getSessionFile();
            await changeState(stateFile, (next) => recordAccess(next, path, file));
          }
          catch (error) { fresh.ui.notify(`Workspace opened, but preferences could not be saved: ${String(error)}`, "warning"); }
        });
        if (result.cancelled) ctx.ui.notify("Workspace switch cancelled", "info");
      } catch (error) { if (!stopped) ctx.ui.notify(`Workspace switch failed: ${String(error)}`, "error"); }
      finally { switching = false; navigating = false; }
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopped = true; pending = undefined; abortDiscovery.abort(); removeInputListener?.(); close?.();
    if (ctx.mode === "tui") {
      try { await remember(ctx); } catch { /* Do not prevent shutdown; previous successful metadata remains. */ }
      ctx.ui.setStatus("workspace", undefined);
    }
  });
}

