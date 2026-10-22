# /// script
# requires-python = ">=3.10"
# dependencies = ["pyte>=0.8.2", "pillow>=11"]
# ///
"""Capture real Pi TUI output with isolated sample projects, then rasterize it.
Run: uv run scripts/capture-screenshots.py
Requires Pi on PATH, Node development dependencies, and a monospace font.
Set PI_SCREENSHOT_FONT to override the default macOS/Linux font selection.
No real user sessions, credentials, or model calls are used.
"""
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time

import pyte
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[1]
ASSETS = REPO / "assets"
ASSETS.mkdir(exist_ok=True)
FONT = os.environ.get("PI_SCREENSHOT_FONT") or next((str(path) for path in [
    Path("/System/Library/Fonts/Menlo.ttc"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
] if path.exists()), None)
if not FONT:
    raise SystemExit("Set PI_SCREENSHOT_FONT to a monospace TTF/TTC file")
font = ImageFont.truetype(FONT, 24)
cell_width = font.getlength("M")
cell_height = 29
fallback_path = Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf")
fallback = ImageFont.truetype(str(fallback_path), 24) if fallback_path.exists() else font


def save_modal(screen, title, destination):
    # Crop the actual modal, omitting unrelated startup output and resource paths.
    top = next(y for y, line in enumerate(screen.display) if title in line and "╭" in line)
    left = screen.display[top].index("╭")
    right = screen.display[top].index("╮")
    bottom = next(y for y in range(top + 1, screen.lines) if "╰" in screen.display[y] and "╯" in screen.display[y])
    padding = 28
    image = Image.new("RGB", (round((right - left + 1) * cell_width) + padding * 2,
                              (bottom - top + 1) * cell_height + padding * 2), "#101318")
    draw = ImageDraw.Draw(image)
    palette = {"black": "#17191f", "red": "#eb6f92", "green": "#9ccfd8", "brown": "#f6c177",
               "blue": "#7aa2f7", "magenta": "#c4a7e7", "cyan": "#9ccfd8", "white": "#e0def4"}

    def color(value, default):
        if value == "default":
            return default
        if len(value) == 6 and all(c in "0123456789abcdefABCDEF" for c in value):
            return "#" + value
        return palette.get(value, default)

    glyphs = []
    for y in range(top, bottom + 1):
        for x in range(left, right + 1):
            char = screen.buffer[y][x]
            foreground = color(char.fg, "#e0def4")
            background = color(char.bg, "#101318")
            if char.reverse:
                foreground, background = background, foreground
            px = padding + (x - left) * cell_width
            py = padding + (y - top) * cell_height
            draw.rectangle((px, py, px + cell_width, py + cell_height), fill=background)
            if char.data and char.data != " ":
                glyphs.append((px, py, char.data, foreground))
    # Paint glyphs after backgrounds so double-width characters aren't erased
    # by the empty continuation cell to their right.
    for px, py, text, foreground in glyphs:
        draw.text((px, py), text, font=fallback if text == "＋" else font, fill=foreground)
    image.save(destination)
    print(f"Saved {destination.relative_to(REPO)} ({image.width} × {image.height})")


with tempfile.TemporaryDirectory(prefix="", dir="/tmp") as directory, \
        tempfile.TemporaryDirectory(prefix="pi-demo-agent-", dir="/tmp") as agent_directory:
    root = Path(directory).resolve()
    projects = root
    names = ["pi-workspace", "karak", "mitti", "qalam"]
    for name in names:
        (projects / name).mkdir()
    env = dict(os.environ, HOME=agent_directory, PI_CODING_AGENT_DIR=str(Path(agent_directory) / "agent"),
               TERM="xterm-256color", COLORTERM="truecolor")
    setup = """
      import {SessionManager} from '@earendil-works/pi-coding-agent';
      import {writeFileSync} from 'node:fs';
      const create = (cwd, name) => {
        const sm=SessionManager.create(cwd);
        writeFileSync(sm.getSessionFile(),JSON.stringify(sm.getHeader())+'\\n');
        SessionManager.open(sm.getSessionFile()).appendSessionInfo(name);
        return sm.getSessionFile();
      };
      const dirs = process.argv.slice(1);
      const files = dirs.map((cwd, i) => create(cwd, ['Workspace navigation', 'Optimize HTTP request handling', 'ASGI cleanup', 'Knowledge search'][i]));
      create(dirs[1], 'Investigate free-threading');
      create(dirs[1], 'Fix benchmark regressions');
      console.log(JSON.stringify(files));
    """
    files = json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-e", setup, *[str(projects / name) for name in names]],
        cwd=REPO, env=env, text=True,
    ))
    for index, file in enumerate(files):
        os.utime(file, (time.time() - index * 60, time.time() - index * 60))
    (Path(agent_directory) / "agent" / "workspace-state.json").write_text(json.dumps({
        "version": 1, "pinned": [str(projects / "karak")], "recent": [str(projects / "mitti")],
        "sessions": {str(projects / "karak"): files[1]}, "discovered": [],
    }))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 110, 0, 0))
    proc = subprocess.Popen(
        ["pi", "--session", files[0], "--no-skills", "--no-prompt-templates", "--no-context-files",
         "-e", str(REPO / "src/index.ts")], cwd=projects / names[0], env=env,
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    os.close(slave)
    screen = pyte.Screen(110, 36)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf8")(errors="replace")

    def drain(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    stream.feed(decoder.decode(os.read(master, 65536)))
                except OSError:
                    break

    try:
        drain(5)
        os.write(master, b"\x18")  # Ctrl+X
        drain(1)
        save_modal(screen, "Switch workspace", ASSETS / "workspace-picker.png")
        os.write(master, b"karak\r")  # Search pinned workspace → session menu
        drain(1)
        save_modal(screen, "Sessions", ASSETS / "workspace-sessions.png")
        os.write(master, b"\x1b")
        drain(0.5)
        os.write(master, b"\x01")  # Ctrl+A
        drain(1)
        save_modal(screen, "Add workspace", ASSETS / "add-workspace.png")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        os.close(master)
