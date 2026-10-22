import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { displayText, type Workspace } from "./workspaces.ts";

export class WorkspacePanel implements Component, Focusable {
  focused = false;
  items: Workspace[] = [];
  selected = 0;
  message = "Loading projects…";
  activePath = "";
  private pageSize = 8;

  private theme: Theme;
  private rows: () => number;
  private select: (workspace: Workspace) => void;
  private release: () => void;
  private toggle: () => void;
  private refresh: () => void;
  private redraw: () => void;

  constructor(
    theme: Theme,
    rows: () => number,
    select: (workspace: Workspace) => void,
    release: () => void,
    toggle: () => void,
    refresh: () => void,
    redraw: () => void,
  ) {
    this.theme = theme;
    this.rows = rows;
    this.select = select;
    this.release = release;
    this.toggle = toggle;
    this.refresh = refresh;
    this.redraw = redraw;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "alt+w")) this.release();
    else if (matchesKey(data, "alt+shift+w")) this.toggle();
    else if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down")) this.selected = Math.min(this.items.length - 1, this.selected + 1);
    else if (matchesKey(data, "pageUp")) this.selected = Math.max(0, this.selected - this.pageSize);
    else if (matchesKey(data, "pageDown")) this.selected = Math.min(this.items.length - 1, this.selected + this.pageSize);
    else if (matchesKey(data, "enter") && this.items[this.selected]) this.select(this.items[this.selected]);
    else if (data === "r") this.refresh();
    this.redraw();
  }

  render(width: number): string[] {
    if (width < 4) return [];
    const inner = width - 2;
    const border = (text: string) => this.theme.fg(this.focused ? "accent" : "border", text);
    const row = (text: string) => {
      const clipped = truncateToWidth(text, inner);
      return border("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + border("│");
    };
    this.pageSize = Math.max(1, Math.floor((this.rows() - 9) / 2));
    this.selected = Math.max(0, Math.min(this.selected, this.items.length - 1));
    const start = Math.floor(this.selected / this.pageSize) * this.pageSize;
    const lines = [border(`╭${"─".repeat(inner)}╮`), row(" WORKSPACES"), row("")];
    for (const [offset, item] of this.items.slice(start, start + this.pageSize).entries()) {
      const selected = this.focused && start + offset === this.selected;
      const marker = item.path === this.activePath ? "●" : " ";
      const label = ` ${selected ? ">" : " "}${marker} ${displayText(item.name)}`;
      lines.push(row(this.theme.fg(selected ? "accent" : "text", label)));
      lines.push(row(this.theme.fg("dim", `    ${displayText(item.path)}`)));
    }
    lines.push(row(this.theme.fg("muted", ` ${displayText(this.message)}`)));
    lines.push(row(this.theme.fg("dim", this.focused ? " ↑↓ Enter · Esc back · r refresh" : " Alt+W focus")));
    lines.push(row(this.theme.fg("dim", " Alt+Shift+W hide/show")));
    lines.push(border(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  invalidate(): void {}
}
