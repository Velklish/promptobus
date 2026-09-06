# PB-45 · readSession and listSessions swallow the harnessStateHome refusal into null and [], so a caller with no registry home sees an empty registry instead of the GateError PB-2 built

- **Scope:** [reference/02-host](../../reference/02-host.md), `lib/cursor-persist.js`, `lib/codex-session.js`, `lib/harness-home.js`, `lib/driver-cursor.js`, `lib/driver-codex.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Three catch-all blocks sit on the registry read path and turn a configuration refusal into a quiet empty answer:

- `lib/cursor-persist.js:257-263` — `export function readSession(ref, env = process.env) { try { return JSON.parse(readFileSync(sessionFile(ref, env), 'utf8')); } catch { return null; } }`
- `lib/codex-session.js:114-120` — the identical body.
- `lib/codex-session.js:148-155` — `listSessions` wraps `readdirSync(sessionsDir(env))` in the same catch-all and answers `[]`.

The call chain is `sessionFile` → `sessionsDir` → `harnessStateHome` (`lib/cursor-persist.js:154`, `lib/codex-session.js:67`), which throws `GateError` at `lib/harness-home.js:80-83` when neither `PROMPTOBUS_<HARNESS>_HOME` nor a bound host names a directory. `lib/harness-home.js:1-32` states the intended behaviour in its own header comment: "otherwise it is a refusal that names both of them" — naming the env var and the host method — as the fix for exactly the failure mode `PB-2` found (the registry silently writing to the operator's real home while `inspect` read a sandbox, "with no error anywhere").

Probed directly on the current tree (both `PROMPTOBUS_CURSOR_HOME`/`PROMPTOBUS_CODEX_HOME` unset, no host bound): `readSession('worker:live')` returns `null` for both harnesses and `listSessions()` returns `[]`, while calling `sessionsDir()` on the same line throws `GateError: no state home for harness cursor: set PROMPTOBUS_CURSOR_HOME`. The lie propagates into the driver: `cursorDriver.inspect('worker:live')` answers `{"state":"gone","stall":{"kind":"gone","reason":"no session record in the Cursor registry"},...}`, built from `!record` at `lib/driver-cursor.js:718-722` — naming a registry the process never opened. `lib/driver-codex.js:295` carries the identical string for the same reason. The same wording appears on `stop` (`lib/driver-cursor.js:1029`, `lib/driver-codex.js:239`) and the wake path (`lib/driver-codex.js:358`).

`grep -rn "no state home" test/*.mjs` returns nothing: the `GateError` assertions in the suite cover host declarations and driver selection, never this read path.

## Work to do

- In the three catch blocks — `lib/cursor-persist.js:260`, `lib/codex-session.js:117`, `lib/codex-session.js:152` — catch the value, test `e instanceof GateError`, and rethrow; keep returning `null`/`[]` only for an actual missing-file or parse failure. Import `GateError` in `codex-session.js` the way `harness-home.js` does: `from '../dist/index.js'`.
- Decide and write down whether `inspect` (and `stop`, and the wake path) propagate the GateError or answer a distinguishable outcome — either way `stall.reason` at `lib/driver-cursor.js:722` and `lib/driver-codex.js:295` must stop saying "no session record in the ... registry" when the registry was never opened; that wording is only true once a directory was actually read.
- A test in the shape the suite already uses for `GateError`: with the harness home unset and no bound host, `readSession` and `cursorDriver.inspect` refuse and the message names the variable and `harnessStateHome`; with the home named and no file on disk, `readSession` still answers `null` and `inspect` still answers `gone`.
- A line in `docs/reference/02-host.md` beside the `harnessStateHome` paragraphs (around line 67) saying the registry read path raises the refusal rather than answering empty.

## Out of scope

- Threading a host through the thirty-odd registry call sites — `lib/harness-home.js:23-32` already argues this case and the process-wide binding stands.

## Verification

- With `PROMPTOBUS_CURSOR_HOME` unset and no host bound, `readSession('x')` and `listSessions()` throw `GateError` naming `PROMPTOBUS_CURSOR_HOME`, instead of returning `null`/`[]`.
- With the home set to an empty directory, `readSession('x')` still returns `null` and `cursorDriver.inspect('x')` still answers `gone` — the missing-file case is unaffected.
- A mutation probe: remove the rethrow and the first assertion above goes red.
