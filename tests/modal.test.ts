import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { modalContentWidth, modalFooter, renderModal } from "../src/modal.ts";

const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m` } as Theme;

test("modal has a closed, aligned frame at narrow and wide sizes", () => {
  for (const width of [12, 16, 36, 76, 120]) {
    const lines = renderModal(theme, width, {
      title: "Switch workspace", top: "Search >", body: ["very long " + "文".repeat(80)],
      status: "Ready", footer: modalFooter(theme, modalContentWidth(width), "picker"),
    });
    assert.ok(lines[0].includes("╭"));
    assert.ok(lines[0].includes("╮"));
    assert.ok(lines.at(-1)?.includes("╰"));
    assert.ok(lines.at(-1)?.includes("╯"));
    for (const line of lines) assert.equal(visibleWidth(line), width);
    assert.equal(lines.filter((line) => line.includes("├")).length, 2);
  }
});

test("padding preserves input cursor marker and tiny widths render nothing", () => {
  const options = { title: "Add workspace", top: `> ${CURSOR_MARKER}folder`, body: [], status: "", footer: "Esc" };
  assert.ok(renderModal(theme, 76, options).some((line) => line.includes(CURSOR_MARKER)));
  assert.deepEqual(renderModal(theme, 5, options), []);
});
