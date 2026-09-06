# PB-93 · Cursor's binary name is resolved two different ways: lift asks only for cursor-agent, but stop's findCursorBin searches a bare agent first and against a different environment

- **Order:** 850
- **Scope:** `lib/driver-cursor.js` (`CURSOR_TOOL`, `CURSOR_BINS`, `findCursorBin`, `liveBin`), `lib/cursor-persist.js` (`stopSession`), [reference/02-host.md](../../reference/02-host.md) § Tool binaries
- **Created:** 2026-09-06
- **Dependencies:** PB-85

## Context

Lift resolves the Cursor binary through the host: `CURSOR_TOOL = 'cursor-agent'` (`lib/driver-cursor.js:57`), consumed by `host.resolveToolBin(CURSOR_TOOL)` per `docs/reference/02-host.md` § Tool binaries (line 77: "For Cursor those differ: the harness is `cursor`, the binary is `cursor-agent`"). `CURSOR_TOOL`'s own docstring (lines 42-56) argues for `cursor-agent` over a bare `agent` specifically because it "cannot collide with a stranger's binary of that name on a shared PATH" — but the file's OWN name-resolution list disagrees: `const CURSOR_BINS = ['agent', 'cursor-agent', 'cursor'];` (line 72), unchanged even by the commit that wrote that docstring (`git show 5c07b1c -- lib/driver-cursor.js` shows `CURSOR_BINS` untouched; that commit only added the comment).

`findCursorBin` (lines 117-128) iterates `CURSOR_BINS` in the OUTER loop and `[...pathDirs, ...extra]` in the inner one — so it exhausts every directory on `PATH` plus the install dirs looking for a bare `agent` before ever trying `cursor-agent` anywhere. This function backs `stop`'s teardown path: `liveBin(recorded)` (lines 975-986) calls `findCursorBin()` with NO arguments — always resolving against `process.env`, never whatever `env` the caller passed — and `stop(ref, waitOptions)` (line 1031) calls `stopSession(record, { bin: liveBin(record.bin), ...(waitOptions ?? {}) })`. `stopSession` (`lib/cursor-persist.js:1026-1046`) then runs `run(agent, ['persist', 'stop', name], { ..., env, ... })` with `agent = bin || record?.bin` — whatever `liveBin` resolved is what actually gets executed with the args `persist stop <session-name>`.

So on a machine where a bare `agent` binary exists anywhere on `PATH` ahead of `cursor-agent` — or, since `CURSOR_INSTALL_DIRS` (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) are appended after `PATH` and searched name-first, on a `PATH` layout that differs from what lift used — `stop` can invoke a different binary than the one that was lifted. There is a second, smaller divergence in the same code: `liveBin` resolves against `process.env` while the actual `run()` call inside `stopSession` uses whatever `env` `waitOptions` supplied — the resolve and the execution can see two different environments.

This has not surfaced as a failing test because the suite seals `PATH` for its own runs (`test/run.mjs:512-513`, "the suite runs with PATH sealed to SEAL_DIR — one directory of symlinks to the binaries hygiene.mjs lists, and nothing else"), so a bare `agent` never sits on it during the suite; it bites only a real operator whose environment differs from `process.env`, or a genuine bare `agent` binary earlier on `PATH` than `cursor-agent`.

Severity is tempered by a fallback: if the harness command does not actually end the session, `stopSession` falls back to `tmux(['kill-session', ...])` directly (`lib/cursor-persist.js:1057`), so the worst outcome today is a stray invocation of a wrong binary rather than a session that never stops.

## Work to do

- Reorder `CURSOR_BINS` to `['cursor-agent', 'agent', 'cursor']` so `findCursorBin` (used by both lift, through the host, and `stop`) prefers the same binary name in both places.
- Have `liveBin` accept and forward the caller's `env` into `findCursorBin` instead of implicitly defaulting to `process.env`, so the binary resolved at stop and the environment used to run it are the same object.
- Update `CURSOR_TOOL`'s docstring (lines 42-56) if the reordering changes which sentence in it is still true ("it is second in this file's own CURSOR_BINS search order").

## Out of scope

- Any change to how lift itself resolves the binary via `host.resolveToolBin` — that path is already correct and unaffected.
- The tmux fallback in `stopSession` (line 1057) — it already covers the failure mode this entry describes; this entry closes the cause, not the safety net.

## Verification

- A test asserting `findCursorBin` returns a `cursor-agent` match ahead of a bare `agent` match when both are present on the search path.
- A test asserting `liveBin` passed a non-default `env` resolves against that `env`, not `process.env`.
- `npm test` stays green.

## Triage — 2026-09-07

- **Track:** D — Harness registries and Cursor / Claude drivers.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/driver-cursor.js:57`, `lib/cursor-persist.js:1026`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
