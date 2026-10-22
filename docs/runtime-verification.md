# Runtime verification — source 0.2.0

Tested against installed `@earendil-works/pi-coding-agent` **0.80.6** on macOS, with Node **22.23.2**. No Pi core changes are made.

## New sessions in another directory

The extension command `ctx.newSession()` does not accept a destination cwd in this Pi version. `SessionManager.create(cwd)` allocates a public session identity/path, but persistence is lazy and there is no public flush method.

The implementation uses a small, explicit bridge:

1. Validate and canonicalize the chosen directory.
2. Call public `SessionManager.create(cwd)`.
3. Read its public `getHeader()` and `getSessionFile()` values.
4. Exclusively create the new file (`wx`, mode 0600) and write only that documented JSONL session header; sync and close it.
5. Validate ownership, recheck idle state, and call public `ctx.switchSession(file, { withSession })`.
6. In the fresh context, compare canonical runtime cwd, session cwd, and prompt-input cwd.

Pi owns runtime construction, trust prompts, tool binding, resource loading, and later session writes. This never copies another session, changes `process.cwd()`, accesses private fields, or fabricates an assistant response to force persistence. The first user message is persisted normally when Pi opens the header-only file.

The bridge is version-sensitive and must be re-tested when changing supported Pi versions. A future upstream `newSession({ cwd })` option should perform target validation, project trust, cwd-bound service construction, and fresh-context callbacks inside Pi itself. It would remove the need to materialize the initial header externally.

## Verification coverage

### Real SDK runtime: `tests/runtime-isolation.test.ts`

Creates two isolated project directories and a temporary agent/session store, then replaces the actual `AgentSessionRuntime` A → B → A. For each destination it checks:

- Runtime and session cwd.
- Unique project `AGENTS.md` content, with the other project's marker absent.
- Project-local settings values.
- Correct local skills and extension source paths; no leaking source paths from the other project.
- Independent saved conversation entries restored from Pi sessions.
- `read`, `write`, `edit`, and `bash` taken from **`runtime.session.agent.state.tools`**, not independently constructed factories. Relative reads match destination markers, `pwd` reports the destination, and created/edited files do not appear in the other repository.

Additional tests exercise empty first-session headers, wrong ownership, malformed/missing session files, and an idle-to-busy race during asynchronous validation.

### Real TUI: `tests/tui-smoke.py`

Runs the installed Pi executable in a pseudo-terminal with isolated HOME and agent storage. No API calls or real user conversations are used. It verifies:

- Footer-only startup and automatic repository discovery from configured roots.
- Two-step project/session navigation and preservation of unsent drafts.
- A → B → A restoration, plus repeated previous-workspace toggles.
- Explicit directory registration without an implicit workspace change.
- First-session creation in an untouched directory and another fresh session in that same project.
- Global session search opens the matching project's session.
- Pin metadata persists.
- An injected exception in a post-switch callback causes the interactive host to exit with status 1. The test records reaching the failure callback, so an unrelated startup error cannot satisfy this assertion.

### Component and persistence tests

Cover fuzzy matching, date/project filtering, opt-in content search, last-active session preference, stale-pointer fallback, empty-project session actions, modal bounds, directory browser navigation, registration validation, atomic metadata writes, concurrent writers, pins/recents, discovery bounds/depth/ignore/symlink policy, and config validation.

## Failure behavior

Before replacement, validation errors and busy-state rechecks leave the old runtime active. The extension blocks prompts, new user shell commands, and tool calls during its own transition window.

Pi 0.80.6 tears down the old runtime **before** constructing the next one. In TUI mode, fatal replacement errors terminate Pi. The extension does not attempt rollback using a stale context. Verification callback errors intentionally propagate to the host's fatal handler.

Metadata failures after successful replacement are reported separately; they do not pretend the runtime was rolled back. A cancelled first-session attempt may leave a harmless header-only session file.

## Limits of the evidence

- No LLM provider behavior is exercised. Model selection and CLI/project/session precedence remain Pi's responsibility.
- Test fixtures explicitly trust their own project configuration in the SDK test. The CLI's real trust workflow is not bypassed by the extension.
- Arbitrary shell/background processes, independent subagents, and malicious concurrent filesystem changes are outside this test boundary.
- No cross-directory runtime rollback API is assumed.
- This is not proof of correctness for all Pi versions, all terminals, all filesystems, or all third-party extensions. Linux and later Pi versions need their own verification runs.
