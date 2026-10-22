import { basename } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, fuzzyFilter, matchesKey, type Component, type Focusable, type SelectItem } from "@earendil-works/pi-tui";
import { displayText, type Workspace } from "./workspaces.ts";
import { DirectoryBrowser } from "./directory-browser.ts";
import { modalContentWidth, renderModal } from "./modal.ts";
import { searchSessions, sessionTitle, type SessionTarget, type WorkspaceSession } from "./sessions.ts";
import { parseState, type WorkspaceState } from "./state.ts";

export interface NavigationOptions {
  pin: (path: string) => Promise<void>;
  discover: () => Promise<void>;
  pickerShortcut: string;
  contentSearch: boolean;
}

export class WorkspacePicker implements Component, Focusable {
  private input = new Input();
  private list: SelectList;
  private choices: SelectItem[] = [];
  private items: Workspace[] = [];
  private sessions: WorkspaceSession[] = [];
  private state = parseState(undefined);
  private theme: Theme;
  private rows: () => number;
  private cancel: () => void;
  private redraw: () => void;
  private pageSize = 8;
  private browser?: DirectoryBrowser;
  private addOptions?: { initial: string; register: (path: string) => Promise<string> };
  private navigation?: NavigationOptions;
  private mode: "workspaces" | "sessions" | "search" = "workspaces";
  private destination?: Workspace;
  private workspaceQuery = "";
  private busy = false;
  activePath = "";
  message = "Loading projects…";

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; if (this.browser) this.browser.focused = value; }
  get handlesEnter(): boolean { return !this.selectedTarget; }
  get selectedTarget(): SessionTarget | undefined {
    if (this.browser || this.busy || this.mode === "workspaces") return undefined;
    const value = this.list.getSelectedItem()?.value;
    if (value === "new" && this.destination) return { workspace: this.destination.path, create: true };
    const session = this.sessions.find((s) => `session:${s.path}` === value);
    if (session) return { workspace: session.workspace, file: session.path };
    if (value === "continue" && this.destination) {
      const sessions = this.sessions.filter((s) => s.workspace === this.destination!.path);
      const remembered = sessions.find((s) => s.path === this.state.sessions[this.destination!.path]);
      const latest = remembered ?? sessions[0];
      if (latest) return { workspace: latest.workspace, file: latest.path };
    }
    return undefined;
  }
  get selectedWorkspace(): Workspace | undefined {
    if (this.browser) return undefined;
    return this.items.find((item) => item.path === this.list.getSelectedItem()?.value);
  }

  constructor(theme: Theme, rows: () => number, cancel: () => void, redraw: () => void) {
    this.theme = theme; this.rows = rows; this.cancel = cancel; this.redraw = redraw;
    this.list = this.makeList();
  }
  configureAdd(initial: string, register: (path: string) => Promise<string>): void {
    this.addOptions = { initial, register }; this.list = this.makeList();
  }
  configureNavigation(options: NavigationOptions): void { this.navigation = options; }
  setItems(items: Workspace[]): void {
    const selected = this.items.length ? this.list.getSelectedItem()?.value : undefined;
    this.items = items; this.rebuild(selected);
  }
  setSessions(sessions: WorkspaceSession[], state: WorkspaceState): void {
    const selected = this.list.getSelectedItem()?.value;
    this.sessions = sessions; this.state = state; this.rebuild(selected);
  }
  private rebuild(selected?: string) {
    this.list = this.makeList();
    const index = this.choices.findIndex((item) => item.value === selected);
    if (index >= 0) this.list.setSelectedIndex(index);
  }
  private openBrowser(): void {
    if (!this.addOptions || this.browser) return;
    const { initial, register } = this.addOptions;
    const browser = new DirectoryBrowser(this.theme, this.rows, initial, () => {
      this.browser?.dispose(); this.browser = undefined; this.redraw();
    }, async (path) => {
      const added = await register(path);
      if (this.browser !== browser) return;
      browser.dispose(); this.browser = undefined; this.input.setValue("");
      this.rebuild(added); this.message = "Workspace registered · Enter to choose a session"; this.redraw();
    }, this.redraw);
    this.browser = browser; browser.focused = this.focused; this.redraw();
  }

  private makeList(): SelectList {
    const query = this.input.getValue();
    const choices: SelectItem[] = [];
    if (this.mode === "workspaces") {
      if (this.addOptions) choices.push({ value: "add-workspace", label: "＋ Add workspace…", description: "Browse or paste a directory path" });
      const filtered = fuzzyFilter(this.items, query, (item) => `${item.name} ${item.path}`);
      const groups: [string, Workspace[]][] = this.navigation && !query
        ? [
          ["Pinned", filtered.filter((w) => this.state.pinned.includes(w.path))],
          ["Recent", filtered.filter((w) => !this.state.pinned.includes(w.path) && this.state.recent.includes(w.path)).sort((a, b) => this.state.recent.indexOf(a.path) - this.state.recent.indexOf(b.path))],
          ["All projects", filtered.filter((w) => !this.state.pinned.includes(w.path) && !this.state.recent.includes(w.path))],
        ] : [["", filtered]];
      for (const [group, entries] of groups) {
        if (!entries.length) continue;
        if (group) choices.push({ value: `group:${group}`, label: group.toUpperCase() });
        for (const item of entries) {
          const count = this.sessions.filter((s) => s.workspace === item.path).length;
          choices.push({ value: item.path,
            label: `${item.path === this.activePath ? "●" : this.state.pinned.includes(item.path) ? "★" : " "} ${displayText(item.name)}`,
            description: `${displayText(item.path)} · ${count ? `${count} sessions` : "New session"}` });
        }
      }
    } else {
      const candidates = this.mode === "sessions" ? this.sessions.filter((s) => s.workspace === this.destination?.path) : this.sessions;
      if (this.mode === "sessions" && !query) {
        const remembered = candidates.some((s) => s.path === this.state.sessions[this.destination!.path]);
        if (candidates.length) choices.push({ value: "continue", label: remembered ? "Continue last active session" : "Continue latest session" });
        choices.push({ value: "new", label: "＋ New session", description: "Independent conversation in this project" });
      }
      for (const session of searchSessions(candidates, query, this.navigation?.contentSearch)) {
        choices.push({ value: `session:${session.path}`, label: displayText(sessionTitle(session)),
          description: `${this.mode === "search" ? `${displayText(basename(session.workspace))} · ` : ""}${session.modified.toISOString().slice(0, 16).replace("T", " ")} UTC` });
      }
      if (this.mode === "sessions" && query) choices.push({ value: "new", label: "＋ New session" });
    }
    this.choices = choices;
    const list = new SelectList(choices, this.pageSize, {
      selectedPrefix: (s) => this.theme.fg("accent", s), selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("dim", s), scrollInfo: (s) => this.theme.fg("dim", s), noMatch: (s) => this.theme.fg("muted", s),
    });
    const first = this.mode === "workspaces" ? choices.findIndex((c) => c.value.startsWith("/")) : 0;
    list.setSelectedIndex(Math.max(0, first));
    return list;
  }

  private async action(run: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    try { await run(); }
    catch (error) { this.message = String(error); }
    finally { this.busy = false; this.redraw(); }
  }
  handleInput(data: string): void {
    const shortcut = this.navigation?.pickerShortcut ?? "ctrl+x";
    if (matchesKey(data, shortcut as "ctrl+x") || matchesKey(data, "alt+w")) { this.cancel(); return; }
    if (this.browser) { this.browser.handleInput(data); return; }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.mode !== "workspaces") {
        this.mode = "workspaces"; this.input.setValue(this.workspaceQuery); this.rebuild(this.destination?.path); this.destination = undefined;
      } else this.cancel();
      this.redraw(); return;
    }
    if (this.busy) return;
    if (matchesKey(data, "ctrl+a") && this.mode === "workspaces") { this.openBrowser(); return; }
    if (matchesKey(data, "ctrl+s") && this.navigation) {
      if (this.mode === "workspaces") this.workspaceQuery = this.input.getValue();
      this.mode = "search"; this.input.setValue(""); this.rebuild(); this.redraw(); return;
    }
    if (matchesKey(data, "ctrl+r") && this.navigation) { void this.action(this.navigation.discover); return; }
    if (matchesKey(data, "ctrl+p") && this.navigation && this.selectedWorkspace) {
      const path = this.selectedWorkspace.path;
      void this.action(() => this.navigation!.pin(path)); return;
    }
    if (matchesKey(data, "enter")) {
      if (this.list.getSelectedItem()?.value === "add-workspace") this.openBrowser();
      else if (this.mode === "workspaces" && this.selectedWorkspace) {
        this.destination = this.selectedWorkspace; this.workspaceQuery = this.input.getValue();
        this.mode = "sessions"; this.input.setValue(""); this.rebuild();
      }
    } else if ((["up", "down", "pageUp", "pageDown"] as const).some((key) => matchesKey(data, key))) {
      this.list.handleInput(data);
      if (this.list.getSelectedItem()?.value.startsWith("group:")) {
        this.list.handleInput(matchesKey(data, "up") || matchesKey(data, "pageUp") ? "\x1b[A" : "\x1b[B");
      }
    } else {
      const before = this.input.getValue(); this.input.handleInput(data);
      if (before !== this.input.getValue()) this.rebuild();
    }
    this.redraw();
  }

  render(width: number): string[] {
    if (width < 12) return [];
    if (this.browser) return this.browser.render(width);
    const contentWidth = modalContentWidth(width);
    const pageSize = Math.max(1, Math.min(8, this.rows() - 11));
    if (pageSize !== this.pageSize) { this.pageSize = pageSize; this.rebuild(this.list.getSelectedItem()?.value); }
    const label = contentWidth >= 20 ? "Search  " : "";
    const input = this.input.render(Math.max(1, contentWidth - label.length))[0] ?? "";
    const title = this.mode === "workspaces" ? "Switch workspace" : this.mode === "search" ? "Search all sessions" : `Sessions · ${displayText(this.destination?.name ?? "")}`;
    const hint = this.mode === "workspaces" ? "↑↓ Move  Enter Sessions  ^A Add  ^P Pin  ^S Search  ^R Scan  Esc"
      : "↑↓ Move  Enter Open  Esc Back";
    const status = this.mode === "search" ? `project:name after:YYYY-MM-DD before:YYYY-MM-DD · ${this.navigation?.contentSearch ? "content enabled" : "metadata only"}` : this.message;
    return renderModal(this.theme, width, { title, top: this.theme.fg("dim", label) + input,
      body: this.list.render(contentWidth), status: displayText(status), footer: this.theme.fg("dim", hint) });
  }
  invalidate(): void { this.input.invalidate(); this.list.invalidate(); this.browser?.invalidate(); }
  dispose(): void { this.browser?.dispose(); this.browser = undefined; }
}
