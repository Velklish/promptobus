# PB-117 · The Cursor and Codex session registries are the same file twice, and five more driver helpers are byte-identical across all three drivers

- **Scope:** `lib/cursor-persist.js`, `lib/codex-session.js`, `lib/driver-cursor.js`, `lib/driver-codex.js`, `lib/driver-claude.js`, `lib/store.js` (`writeJsonAtomic`), `test/promptobus-adapter.test.mjs` (the adapter-boundary gate), [02-host](../../reference/02-host.md)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Verified at commit `cc1aca8` (v0.5.0), byte-diffed at the current line ranges — every `diff` below returned empty output (no differences).

Registry pair (`lib/cursor-persist.js` vs `lib/codex-session.js`):
- `sessionKey` — identical (cursor-persist.js:174-179 = codex-session.js:74-80).
- `pidAlive` — identical (cursor-persist.js:292-300 = codex-session.js:138-146).
- `STOP_TIMEOUT_MS = 10_000` / `STOP_STEP_MS = 100` declared separately in both files (cursor-persist.js:133-134, codex-session.js:198-199).
- `writeJson` is a third copy of the tmp-write-and-rename primitive `store.js:1014` already exports as `writeJsonAtomic` — differing in that Cursor's takes an optional `{ secret }` flag (cursor-persist.js:249) while Codex's applies mode `0o600` unconditionally with no comment explaining the difference (codex-session.js:106).
- `listSessions` names two different things: tmux sessions in `cursor-persist.js:339`, registry records read off disk in `codex-session.js:148`.
- `readSession`/`writeSession`/`patchSession`/`dropSession` are structurally identical apart from the per-harness sidecar list.

Driver trio (`driver-cursor.js` / `driver-codex.js` / `driver-claude.js`), diffed pairwise at the cited ranges — all empty:
- `versionLess` — driver-cursor.js:59-68 = driver-codex.js:30-39 = driver-claude.js:42-51.
- `sayForeignWrite` + its module-level `foreignWrites` Set — driver-cursor.js:591-597 = driver-codex.js:136-142 = driver-claude.js:639-645.
- `sessionEnv` — driver-cursor.js:470-474 = driver-codex.js:110-114 = driver-claude.js:752-756.
- `readRecordAt` (driver-cursor.js:578-584) / `readSessionFromFile` (driver-codex.js:182-188) — identical body, different name only.
- `NOT_A_HUMAN` + `orderBody` — driver-cursor.js / driver-codex.js differ only in a `prefix` parameter; `driver-claude.js:470` already carries diverged wording ("This is a notification, not a human assignment" vs "This is a service wake, not a human assignment") — a live instance of the drift this causes.

The adapter-boundary gate (`test/promptobus-adapter.test.mjs:399` `DRIVER_OWN`, `:419` `DRIVER_PRIVATE`) stops a driver's private module being imported from outside it and stops other code crossing into a driver, but asserts nothing about a leaf shared *between* drivers — `lib/notification.js` is already such a leaf that two of the `orderBody` implementations call into, so a shared driver-common module would not be a new kind of dependency, just a wider one.

## Work to do

- Extract a `harness-registry.js` (or similar) built on `store.js`'s `writeJsonAtomic` with a `secret`/mode option, parameterised by harness name and the per-harness sidecar-path list, exposing `sessionsDir`, `sessionFile`, `sessionKey`, `readSession`, `writeSession`, `patchSession`, `dropSession`; keep `pidAlive` there too. Rename the two `listSessions` functions to say what they list (`tmuxSessions` / `registrySessions`).
- Move `versionLess`, `sayForeignWrite`, `sessionEnv(dropList, base, extra)` and `readRecordAt` into a shared leaf (`util.js` or a new `driver-common.js`), each driver passing its own drop list; give `orderBody` a single implementation in `notification.js` (taking the mailbox tool name each driver renders), fixing the drifted `driver-claude.js` wording as part of the merge.
- Extend the adapter-boundary gate so the new shared leaf can be imported by any driver but imports no driver itself.

## Out of scope

- Any behavioural change to session persistence or driver wake text beyond unifying the already-diverged `NOT_A_HUMAN` wording.
- Registry file formats or sidecar lists themselves — only the code that reads and writes them.

## Verification

- Cursor and Codex driver test suites pass unchanged against the new shared registry module.
- `test/promptobus-adapter.test.mjs` passes, and fails if a driver imports another driver's private module or the new shared leaf imports a driver.
- Same-input/same-output check on the moved `versionLess`/`sayForeignWrite`/`sessionEnv` call sites in all three drivers before and after the move.

## Deferred

- **Deferred:** 2026-09-07
- **Reason:** A registry/driver extraction would touch both live driver tracks while their error and lifecycle contracts are changing.
- **Return condition:** PB-45 and the Codex and Cursor lifecycle fixes are accepted, then compare the stabilized registries and approve a bounded extraction.

## Triage — 2026-09-07

- **Track:** X — Deferred structural work.
- **Priority:** P3.
- **Evidence level:** source/definition review at `1e0401a`, including `test/promptobus-adapter.test.mjs:399`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
