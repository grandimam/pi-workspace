"""Real-terminal integration: python3 tests/tui-smoke.py. No model/API calls.
Uses isolated agent storage and tests normal UI plus host fail-closed behavior.
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
assert shutil.which("pi"), "Install Pi before running this test"
with tempfile.TemporaryDirectory(prefix="pi-workspace-smoke-") as temporary:
    root = Path(temporary).resolve()
    a, b, c = (root / name for name in ["project-a", "project-b", "new-project"])
    for directory in [a, b, c]: directory.mkdir()
    discovered = root / "discovered-repo"
    (discovered / ".git").mkdir(parents=True)
    (root / "agent").mkdir()
    (root / "agent" / "workspace-config.json").write_text(json.dumps({"roots": [str(root)], "maxDepth": 1}))
    env = dict(os.environ, HOME=str(root), PI_CODING_AGENT_DIR=str(root / "agent"), TERM="xterm-256color")
    setup = """
      import {SessionManager} from '@earendil-works/pi-coding-agent';
      import {writeFileSync} from 'node:fs';
      console.log(JSON.stringify(process.argv.slice(1).map(cwd => {
        const sm=SessionManager.create(cwd);
        writeFileSync(sm.getSessionFile(),JSON.stringify(sm.getHeader())+'\\n');
        return sm.getSessionFile();
      })));
    """
    files = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", setup, str(a), str(b)], cwd=repo, env=env, text=True))
    trace = root / "trace.jsonl"
    observer = root / "observer.ts"
    observer.write_text("""
      import {appendFileSync} from 'node:fs';
      export default function(pi) {
        pi.on('session_start', (_event, ctx) => {
          appendFileSync(%s, JSON.stringify({cwd:ctx.cwd, session:ctx.sessionManager.getSessionFile()})+'\\n');
        });
        pi.registerCommand('test-fatal-replacement', {handler: async (_, ctx) => {
          await ctx.switchSession(%s, {withSession: async () => { appendFileSync(%s, 'reached'); throw new Error('INJECTED_CONTEXT_FAILURE'); }});
        }});
      }
    """ % (json.dumps(str(trace)), json.dumps(files[1]), json.dumps(str(root / "failure-marker"))))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
    proc = subprocess.Popen(["pi", "--session", files[0], "--no-skills", "--no-prompt-templates", "--no-context-files",
        "-e", str(repo / "src/index.ts"), "-e", str(observer)],
        cwd=a, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()
    def drain(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], 0.1)[0]:
                try: output.extend(os.read(master, 65536))
                except OSError: break
    def send(data, delay=0.35):
        os.write(master, data); drain(delay)
    def events(): return [json.loads(line) for line in trace.read_text().splitlines()]
    def choose(project):
        send(b"\x18"); send(project.encode()); send(b"\r"); send(b"\r", 2)
    try:
        drain(4)
        assert b"Switch workspace" not in output
        assert b"Ctrl+X" in output
        assert b"Failed to load extension" not in output
        assert str(discovered) in json.loads((root / "agent" / "workspace-state.json").read_text())["discovered"]
        send(b"typing probe")
        choose("project-b")
        assert len(events()) == 1
        assert b"clear your draft" in output
        send(b"\x18"); send(b"\x15")  # Close modal and clear draft.
        choose("project-b")
        assert events()[-1]["session"] == files[1]
        choose("project-a")
        assert events()[-1]["session"] == files[0]
        send(b"\x1b\x10", 2)  # Ctrl+Alt+P previous
        assert events()[-1]["session"] == files[1]
        send(b"\x1b\x10", 2)
        assert events()[-1]["session"] == files[0]
        send(b"\x18"); send(b"\x01")  # Add directory
        assert b"Add this directory" in output
        send(b"\t"); send(b"\x15"); send(str(c).encode()); send(b"\r")
        registry = root / "agent" / "workspaces.json"
        assert not registry.exists()
        send(b"\x01", 1)
        assert json.loads(registry.read_text())["paths"] == [str(c)]
        assert len(events()) == 5
        send(b"\r"); send(b"\r", 2)  # Sessions → New session in untouched directory
        assert Path(events()[-1]["cwd"]).resolve() == c
        first_c = events()[-1]["session"]
        header = json.loads(Path(first_c).read_text().splitlines()[0])
        assert Path(header["cwd"]).resolve() == c
        assert not any(json.loads(line).get("type") == "message" for line in Path(first_c).read_text().splitlines())
        send(b"\x18"); send(b"new-project"); send(b"\r")
        send(b"\x1b[B"); send(b"\r", 2)  # New session beneath Continue
        second_c = events()[-1]["session"]
        assert second_c != first_c and Path(events()[-1]["cwd"]).resolve() == c
        send(b"\x18"); send(b"\x13")  # Global session search
        send(b"project:project-b"); send(b"\r", 2)
        assert events()[-1]["session"] == files[1]
        send(b"\x18"); send(b"project-b"); send(b"\x10", 1)  # Pin inside picker
        state = json.loads((root / "agent" / "workspace-state.json").read_text())
        assert str(b) in state["pinned"]
        send(b"\x18")
        assert proc.poll() is None
        # Pi's host must terminate rather than accept more work after failed verification.
        send(b"/test-fatal-replacement\r", 3)
        assert proc.poll() == 1
        assert (root / "failure-marker").read_text() == "reached"
        print("PASS: session picker, draft guard, A/B restore, previous toggle, registration, first/new sessions, global search, pins, fail-closed replacement")
    except Exception:
        print(output.decode(errors="replace")[-8000:])
        raise
    finally:
        if proc.poll() is None: proc.terminate()
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
        os.close(master)
