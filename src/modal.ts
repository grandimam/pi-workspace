import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Shared geometry for both modal screens. Content always fits inside the border. */
export function modalContentWidth(width: number): number {
  return Math.max(1, width - 2 - 2 * (width >= 40 ? 2 : 1));
}

export function modalFooter(theme: Theme, width: number, mode: "picker" | "browse" | "path", canAdd = true): string {
  const compact = width < 56;
  const hints = mode === "path"
    ? [["Tab", "Complete"], ["Enter", "Browse"], ["Esc", "Back"]]
    : mode === "browse"
      ? [["↑↓", "Move"], ["Enter", "Choose"], ["Tab", "Path"], ["Esc", "Back"]]
      : [["↑↓", "Move"], ["Enter", "Open"], ...(canAdd ? [["^A", "Add"]] : []), ["Esc", "Close"]];
  return hints.map(([key, label]) => theme.fg("accent", key) + (compact ? "" : ` ${theme.fg("dim", label)}`)).join("  ");
}

export function renderModal(theme: Theme, width: number, options: {
  title: string;
  top: string;
  body: string[];
  status: string;
  footer: string;
}): string[] {
  if (width < 12) return [];
  const inner = width - 2;
  const padding = width >= 40 ? 2 : 1;
  const contentWidth = modalContentWidth(width);
  const edge = (s: string) => theme.fg("borderAccent", s);
  const row = (text = "") => {
    const clipped = truncateToWidth(text, contentWidth);
    return edge("│") + " ".repeat(padding) + clipped
      + " ".repeat(inner - padding - visibleWidth(clipped)) + edge("│");
  };
  const title = truncateToWidth(options.title, Math.max(1, inner - 4));
  const rule = () => edge(`├${"─".repeat(inner)}┤`);
  return [
    edge("╭─ ") + theme.fg("accent", title) + edge(` ${"─".repeat(Math.max(0, inner - visibleWidth(title) - 3))}╮`),
    row(),
    row(options.top),
    row(),
    rule(),
    ...options.body.map(row),
    row(),
    row(theme.fg("muted", options.status)),
    rule(),
    row(options.footer),
    edge(`╰${"─".repeat(inner)}╯`),
  ];
}
