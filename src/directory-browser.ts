import { dirname, join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import { childDirectories, completeDirectory } from "./directories.ts";
import { validateDirectory } from "./registry.ts";
import { displayText } from "./workspaces.ts";
import { modalContentWidth, modalFooter, renderModal } from "./modal.ts";

export class DirectoryBrowser implements Component, Focusable {
  private input = new Input();
  private list: SelectList;
  private pageSize = 6;
  private generation = 0;
  private disposed = false;
  private children: string[] = [];
  private editing = false;
  private busy = false;
  private valid = false;
  path: string;
  message = "Loading directories…";
  private theme: Theme;
  private rows: () => number;
  private back: () => void;
  private register: (path: string) => Promise<void>;
  private redraw: () => void;

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  constructor(theme: Theme, rows: () => number, initial: string, back: () => void,
    register: (path: string) => Promise<void>, redraw: () => void) {
    this.theme = theme; this.rows = rows; this.path = initial;
    this.back = back; this.register = register; this.redraw = redraw;
    this.list = this.makeList();
    void this.navigate(initial);
  }

  private makeList(): SelectList {
    return new SelectList([
      { value: "parent", label: "↑ Parent directory" },
      { value: "add", label: "＋ Add this directory" },
      ...this.children.map((name) => ({ value: `child:${name}`, label: `▸ ${displayText(name)}` })),
    ], this.pageSize, {
      selectedPrefix: (s) => this.theme.fg("accent", s), selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("dim", s), scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("muted", s),
    });
  }

  async navigate(value: string): Promise<void> {
    const generation = ++this.generation;
    this.busy = true;
    try {
      const path = await validateDirectory(value, this.path);
      const children = await childDirectories(path);
      if (this.disposed || generation !== this.generation) return;
      this.path = path; this.children = children; this.valid = true; this.editing = false;
      this.setPathInput(path);
      this.list = this.makeList();
      this.message = `${children.length} folders · Ctrl+A adds this directory`;
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.message = String(error);
    } finally {
      if (!this.disposed && generation === this.generation) { this.busy = false; this.redraw(); }
    }
  }

  private async add() {
    if (this.busy || !this.valid) return;
    this.busy = true;
    this.message = "Saving workspace…";
    this.redraw();
    try { await this.register(this.path); }
    catch (error) { if (!this.disposed) this.message = String(error); }
    finally { if (!this.disposed) { this.busy = false; this.redraw(); } }
  }

  private async complete() {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await completeDirectory(this.input.getValue(), this.path);
      if (this.disposed) return;
      this.setPathInput(result.value);
      this.message = result.count ? `${result.count} matching folders · Enter to browse` : "No matching folders";
    } catch (error) { if (!this.disposed) this.message = String(error); }
    finally { if (!this.disposed) { this.busy = false; this.redraw(); } }
  }

  private setPathInput(value: string): void {
    this.input.setValue(displayText(value));
    this.input.handleInput("\x05"); // Input.setValue preserves its old cursor; move to the end.
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.editing && !this.busy) this.editing = false;
      else this.back();
    } else if (this.busy) return;
    else if (this.editing) {
      if (matchesKey(data, "enter")) void this.navigate(this.input.getValue());
      else if (matchesKey(data, "tab")) void this.complete();
      else this.input.handleInput(data);
    } else if (matchesKey(data, "tab")) {
      this.editing = true;
      this.setPathInput(this.path);
    } else if (matchesKey(data, "ctrl+a")) void this.add();
    else if (matchesKey(data, "enter")) {
      const selected = this.list.getSelectedItem()?.value;
      if (selected === "add") void this.add();
      else if (selected === "parent") void this.navigate(dirname(this.path));
      else if (selected?.startsWith("child:")) void this.navigate(join(this.path, selected.slice(6)));
    } else this.list.handleInput(data);
    this.redraw();
  }

  render(width: number): string[] {
    if (width < 12) return [];
    const contentWidth = modalContentWidth(width);
    const pageSize = Math.max(1, Math.min(8, this.rows() - 11));
    if (pageSize !== this.pageSize) {
      const selected = this.list.getSelectedItem()?.value;
      this.pageSize = pageSize; this.list = this.makeList();
      const index = selected === "add" ? 1 : selected?.startsWith("child:") ? this.children.indexOf(selected.slice(6)) + 2 : 0;
      this.list.setSelectedIndex(Math.max(0, index));
    }
    const pathLabel = contentWidth >= 20 ? "Path  " : "";
    return renderModal(this.theme, width, {
      title: this.editing ? "Add workspace · Edit path" : "Add workspace",
      top: this.editing
        ? this.theme.fg("dim", pathLabel) + (this.input.render(Math.max(1, contentWidth - pathLabel.length))[0] ?? "")
        : this.theme.fg("text", displayText(this.path)),
      body: this.editing
        ? [this.theme.fg("dim", "Enter a directory path. Tab completes folder names.")]
        : this.list.render(contentWidth),
      status: displayText(this.message),
      footer: modalFooter(this.theme, contentWidth, this.editing ? "path" : "browse"),
    });
  }

  invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
  dispose(): void { this.disposed = true; this.generation++; }
}
