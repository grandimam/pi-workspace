"""Optional real-terminal smoke test: python3 tests/tui-smoke.py.
Requires `pi` 0.80.6 on PATH and npm development dependencies. No LLM calls.
All sessions, settings, and observations live in a temporary directory.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

repo = Path(__file__).resolve().parents[1]
assert shutil.which("pi"), "Install Pi before running the terminal smoke test"

with tempfile.TemporaryDirectory(prefix="pi-workspace-smoke-") as temporary:
    root = Path(temporary).resolve()
    a, b = root / "project-a", root / "project-b"
    a.mkdir()
    b.mkdir()
    c = root / "new-project"
    c.mkdir()
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(root / "agent"), TERM="xterm-256color")
    setup = """
      import {SessionManager} from '@earendil-works/pi-coding-agent';
      import {writeFileSync} from 'node:fs';
      const files=process.argv.slice(1).map(cwd=>{
        const sm=SessionManager.create(cwd);
        writeFileSync(sm.getSessionFile(),JSON.stringify(sm.getHeader())+'\\n');
        return sm.getSessionFile();
      });
      console.log(JSON.stringify(files));
    """
    files = json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-e", setup, str(a), str(b)],
        cwd=repo, env=env, text=True,
    ))
    trace = root / "trace.jsonl"
    observer = root / "observer.ts"
    observer.write_text("""
      import {appendFileSync} from 'node:fs';
      export default function(pi) {
        pi.on('session_start', (_event, ctx) => {
          appendFileSync(%s, JSON.stringify({cwd:ctx.cwd, session:ctx.sessionManager.getSessionFile()})+'\\n');
        });
      }
    """ % json.dumps(str(trace)))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
    proc = subprocess.Popen(
        ["pi", "--session", files[0], "--no-skills", "--no-prompt-templates", "--no-context-files",
         "-e", str(repo / "src/index.ts"), "-e", str(observer)],
        cwd=a, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    os.close(slave)
    output = bytearray()

    def drain(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break

    def send(data, delay=0.4):
        os.write(master, data)
        drain(delay)

    def events():
        return [json.loads(line) for line in trace.read_text().splitlines()]

    try:
        drain(5)
        assert b"Switch workspace" not in output, "Picker must not open automatically"
        assert b"Ctrl+X" in output, "Footer shortcut missing"
        assert b"Failed to load extension" not in output
        send(b"typing probe")
        assert b"typing probe" in output, "Footer interfered with typing"
        send(b"\x18")  # Ctrl+X opens centered picker
        assert b"Switch workspace" in output
        send(b"project-b")  # Search selects B

        send(b"\r")
        assert len(events()) == 1, "Switch must not discard a draft"
        assert b"clear your draft" in output
        send(b"\x1b")  # Escape back to editor
        send(b"\x15")  # Ctrl+U clear draft
        send(b"\x18")  # Ctrl+X reopens with an empty search
        send(b"project-b")
        send(b"\r", 3)
        assert Path(events()[-1]["cwd"]).resolve() == b, "Selection did not switch to B"
        assert events()[-1]["session"] == files[1]
        send(b"\x1bw")  # Original Alt+W remains supported
        send(b"project-a")
        send(b"\r", 3)
        assert Path(events()[-1]["cwd"]).resolve() == a, "Selection did not switch back to A"
        assert events()[-1]["session"] == files[0]
        send(b"\x18")
        send(b"\x01")  # Ctrl+A: Add workspace browser
        assert b"Add this directory" in output
        send(b"\t")  # Edit path
        send(b"\x15")
        send(str(c).encode())
        send(b"\r")  # Browse the entered directory; do not register yet
        registry = root / "agent" / "workspaces.json"
        assert not registry.exists(), "Browsing must not register a project"
        send(b"\x01", 1)  # Explicit add
        assert json.loads(registry.read_text())["paths"] == [str(c)]
        assert len(events()) == 3, "Registration must not switch sessions"
        send(b"\r")  # Newly registered, sessionless project is selected
        assert b"No session yet" in output
        assert len(events()) == 3, "Sessionless workspace must not fake a switch"
        send(b"\x1b")
        send(b"\x18")
        send(b"new-project")
        assert b"new-project" in output
        send(b"\x1b")
        assert proc.poll() is None, "Pi exited unexpectedly"
        print("PASS: searchable switching, directory browser, explicit registration, persistence, no unsafe first-session switch")
    except Exception:
        # Keep diagnostics out of real user sessions and credentials.
        print(output.decode(errors="replace")[-6000:])
        raise
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        os.close(master)
