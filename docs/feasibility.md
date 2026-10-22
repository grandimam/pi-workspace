# Pi Workspace — Phase 0 API assessment

Status: source/API review only; Phase 0 exit criterion is **not yet demonstrated**.

Inspected installed `@earendil-works/pi-coding-agent` **0.80.6** on macOS.
No claim of compatibility with older releases or Linux runtime testing.

## Findings

| Requirement | Finding |
| --- | --- |
| Commands and picker | Public `registerCommand`, `ui.select`, and `ui.custom` APIs exist. |
| Active workspace indicator | `ui.setStatus` and `ui.setWidget` are supported. Derive the indicator from actual runtime cwd, not picker selection. |
| Session discovery | Public `SessionManager.list(cwd)` and `listAll()` exist. Validate session ownership against the canonical destination path. |
| Cross-directory resume | `ctx.switchSession(file, { withSession })` replaces the runtime using the session's cwd. It is not just a conversation swap. |
| Project context reload | The CLI runtime factory recreates cwd-bound settings, resources, model registry, and agent services; project trust is resolved for the destination. CLI overrides remain process-wide. |
| Fresh session in current directory | `ctx.newSession()` is supported. |
| Fresh session in another directory | No destination cwd parameter exists on extension `newSession`. Needs a tested bootstrap mechanism or upstream API addition. |
| Idle detection | `ctx.isIdle()` covers runs, retries, compaction retry, and queued continuation. Additional tests must cover user bash and other operations. |
| Failure recovery | Replacement tears down the old runtime before constructing the new one. The interactive host exits with status 1 on general resume failure; automatic rollback is not provided. |
| Automatic startup restoration | Session-control methods are command-only. Calling them from `session_start` is not a supported route. This requirement needs a separate feasibility test/design. |
| Persistent sidebar | Documented overlays draw over content, rather than reserving sidebar width. A non-overlapping root split-pane layout is not established by the inspected API. |

## Supported switching design

1. Install the extension globally so it is available in every destination. Do not depend on a source project's local extension surviving replacement.
2. Reject a switch while not idle or while another switch is pending.
3. Canonicalize and validate the destination directory.
4. Resolve the stored session reference, validating existence and session-header cwd. Fall back to valid sessions for that workspace if the reference is stale.
5. Persist only registry metadata, not copied conversations. Account for sessions whose file path exists in memory but has not yet been written.
6. Recheck idle state immediately before replacement.
7. Use `ctx.switchSession`, without `process.chdir`, tool overrides, or private runtime mutation.
8. Verify the replacement using only the fresh `withSession` context: canonical `ctx.cwd`, session cwd, and system-prompt cwd must agree with the destination.
9. Record successful access and refresh UI only after verification. Reestablish extension state in `session_start` on each replacement.

Captured old `pi`, command contexts, and session objects must not be used after successful replacement. The callback closure survives, but its old runtime bindings do not.

A metadata-write error after a successful switch is not a failed runtime switch: report it separately without claiming rollback.

## Important gaps

### First visit to an empty workspace

`SessionManager.create(destination)` allocates a session manager and path, but session persistence is lazy. Merely appending custom metadata does not necessarily create the file before an assistant message exists. Therefore `create(...).getSessionFile()` followed by `switchSession(...)` is not a verified bootstrap strategy.

Prefer investigating a public `newSession({ cwd })` enhancement. If bootstrapping a header-only session through the documented file format is considered, isolate it and test persistence, exclusive creation, cancellation, session listing, and empty-history restoration. Do not fabricate assistant messages just to force persistence.

### Failure handling

In this version, the interactive host's general resume-error handler reports the error, stops the TUI, and exits. This fails closed rather than continuing in an ambiguous context, but does not meet a stronger promise of automatic recovery without restarting.

Do not implement catch-and-switch-back using the original command context: it may already be stale. If seamless recovery is required, propose host-owned transactional replacement or host-owned reconstruction of the previous runtime.

### Restart restoration

Distinguish these acceptance criteria:

- Registry and per-project last-session references survive restart.
- Opening `/workspace` resumes the last workspace.
- Starting plain `pi` automatically enters the last workspace before accepting input.

The third is stronger and remains unresolved. Explicit CLI session selection should take precedence over any automatic restoration policy. Avoid timers or synthetic prompts as an unverified startup workaround.

## Required proof before Phase 1

Use two temporary repositories with distinct instructions, settings, skills, local extensions, marker files, and separate conversation histories. Use isolated agent/session storage, not real user credentials or histories.

- Switch A → B → A through an extension command in one TUI process.
- Confirm session identity and history isolation after each transition.
- Execute actual runtime `read`, `write`, `edit`, and `bash` tools against relative paths; verify the other repository is untouched.
- Verify prompt inputs, local resource replacement, trust decisions, and settings/model precedence.
- Test first visits, empty sessions, new sessions, cancellation, stale references, malformed sessions, and missing directories.
- Test active agent/tool operations, retries, compaction, queued messages, user bash, and repeated switch requests.
- Inject destination initialization failure and confirm no further execution occurs under mixed context.
- Restart and test the agreed restoration semantics.

A mock context or independently constructed tool factory is insufficient evidence that Pi's live runtime was switched correctly.

## PRD clarifications to resolve

- Define discovery depth (root at depth zero), ignored directory semantics, symlink policy, and whether nested repositories remain discoverable inside a parent repository.
- Use canonical directory identity; treat Git worktrees as separate workspaces. Renamed directories require explicit relocation handling.
- Specify removal behavior for discovered projects: exclusion/tombstone or reappearance on refresh.
- Disambiguate duplicate project names using path or ID.
- Define shared-registry multi-process behavior; atomic rename alone does not prevent lost updates.
- Keep runtime isolation distinct from sandboxing: global credentials and trusted extensions remain subject to Pi's existing security model.
- Resolve session-picker scope: FR-04/FR-06 require it, while milestones place it in Phase 2.

## Evidence inspected

Paths relative to the installed Pi package:

- `package.json`: installed version.
- `docs/extensions.md`: command contexts, replacement lifecycle, idle detection, UI, and project trust.
- `docs/sdk.md`: runtime replacement and cwd-bound services.
- `docs/session-format.md`: session ownership, storage, and public manager APIs.
- `docs/tui.md`: picker, status, widget, and overlay capabilities.
- `examples/extensions/handoff.ts`: fresh replacement-context usage.
- `dist/core/extensions/types.d.ts`: exact command API signatures.
- `dist/core/agent-session-runtime.js`: destination cwd selection and teardown ordering.
- `dist/main.js`: rebuilding project-bound services and resolving trust.
- `dist/core/session-manager.js`: lazy persistence.
- `dist/modes/interactive/interactive-mode.js`: resume handling and fatal error behavior.

Recommendation: proceed with the two-repository proof, not the full MVP yet. Cross-directory resume has a supported foundation; empty-workspace creation, automatic startup restoration, and failure behavior must be settled before declaring the complete extension-only MVP feasible.
