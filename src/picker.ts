import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, fuzzyFilter, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import { displayText, type Workspace } from "./workspaces.ts";
import { DirectoryBrowser } from "./directory-browser.ts";
import { modalContentWidth, modalFooter, renderModal } from "./modal.ts";

/** Short-lived quick switcher. The normal editor remains untouched underneath. */
export class WorkspacePicker implements Component, Focusable {
  private input = new Input();
  private list: SelectList;
  private items: Workspace[] = [];
  private theme: Theme;
  private rows: () => number;
  private cancel: () => void;
  private redraw: () => void;
  private pageSize = 8;
  private browser?: DirectoryBrowser;
  private addOptions?: { initial: string; register: (path: string) => Promise<string> };
  activePath = "";
  message = "Loading projects…";

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; if (this.browser) this.browser.focused = value; }

  configureAdd(initial: string, register: (path: string) => Promise<string>): void {
    this.addOptions = { initial, register };
    this.list = this.makeList();
  }

  get handlesEnter(): boolean { return !!this.browser || this.list.getSelectedItem()?.value === "add-workspace"; }

  private openBrowser(): void {
    if (!this.addOptions || this.browser) return;
    const { initial, register } = this.addOptions;
    const browser = new DirectoryBrowser(this.theme, this.rows, initial, () => {
      this.browser?.dispose(); this.browser = undefined; this.redraw();
    }, async (path) => {
      const added = await register(path);
      if (this.browser !== browser) return;
      browser.dispose(); this.browser = undefined;
      this.input.setValue("");
      this.list = this.makeList();
      this.list.setSelectedIndex(Math.max(0, this.items.findIndex((item) => item.path === added)) + (this.addOptions ? 1 : 0));
      this.message = "Workspace registered · select it to open";
      this.redraw();
    }, this.redraw);
    this.browser = browser;
    browser.focused = this.focused;
    this.redraw();
  }

  constructor(theme: Theme, rows: () => number, cancel: () => void, redraw: () => void) {
    this.theme = theme;
    this.rows = rows;
    this.cancel = cancel;
    this.redraw = redraw;
    this.list = this.makeList();
  }

  setItems(items: Workspace[]): void {
    this.items = items;
    this.list = this.makeList();
  }

  get selectedWorkspace(): Workspace | undefined {
    if (this.browser) return undefined;
    const value = this.list.getSelectedItem()?.value;
    return this.items.find((item) => item.path === value);
  }

  private makeList(): SelectList {
    const filtered = fuzzyFilter(this.items, this.input.getValue(), (item) => `${item.name} ${item.path}`);
    const list = new SelectList([
      ...(this.addOptions ? [{ value: "add-workspace", label: "＋ Add workspace…", description: "Browse or paste a directory path" }] : []),
      ...filtered.map((item) => ({
      value: item.path,
      label: `${item.path === this.activePath ? "● " : "  "}${displayText(item.name)}`,
      description: `${displayText(item.path)}${!item.sessionFile && item.path !== this.activePath ? " · No session yet" : ""}`,
    }))], this.pageSize, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("dim", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("muted", s),
    });
    // Keep Enter useful for switching; Up reaches the leading Add action.
    list.setSelectedIndex(this.addOptions && filtered.length ? 1 : 0);
    return list;
  }

  handleInput(data: string): void {
    if ((["ctrl+x", "alt+w"] as const).some((key) => matchesKey(data, key))) {
      this.cancel(); return;
    }
    if (this.browser) { this.browser.handleInput(data); return; }
    if ((["escape", "ctrl+c"] as const).some((key) => matchesKey(data, key))) {
      this.cancel();
      return;
    }
    if (matchesKey(data, "ctrl+a") || (matchesKey(data, "enter") && this.handlesEnter)) {
      this.openBrowser(); return;
    }
    if ((["up", "down", "pageUp", "pageDown"] as const).some((key) => matchesKey(data, key))) {
      this.list.handleInput(data);
    } else if (!matchesKey(data, "enter")) {
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (before !== this.input.getValue()) this.list = this.makeList();
    }
    // Enter is intercepted by the extension and forwarded to Pi's command pipeline.
    this.redraw();
  }

  render(width: number): string[] {
    if (width < 12) return [];
    if (this.browser) return this.browser.render(width);
    const contentWidth = modalContentWidth(width);
    const pageSize = Math.max(1, Math.min(8, this.rows() - 11));
    if (pageSize !== this.pageSize) {
      this.pageSize = pageSize;
      const selected = this.list.getSelectedItem()?.value;
      this.list = this.makeList();
      const filtered = fuzzyFilter(this.items, this.input.getValue(), (item) => `${item.name} ${item.path}`);
      this.list.setSelectedIndex(selected === "add-workspace" ? 0 : Math.max(0, filtered.findIndex((item) => item.path === selected)) + (this.addOptions ? 1 : 0));
    }
    const searchLabel = contentWidth >= 20 ? "Search  " : "";
    const input = this.input.render(Math.max(1, contentWidth - searchLabel.length))[0] ?? "";
    return renderModal(this.theme, width, {
      title: "Switch workspace",
      top: this.theme.fg("dim", searchLabel) + input,
      body: this.list.render(contentWidth),
      status: displayText(this.message),
      footer: modalFooter(this.theme, contentWidth, "picker", !!this.addOptions),
    });
  }

  invalidate(): void { this.input.invalidate(); this.list.invalidate(); this.browser?.invalidate(); }
  dispose(): void { this.browser?.dispose(); this.browser = undefined; }
}
