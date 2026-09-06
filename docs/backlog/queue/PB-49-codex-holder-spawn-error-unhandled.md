# PB-49 · The Codex holder attaches no `error` listener to the spawned app-server, so a binary that cannot be spawned kills the holder silently, leaves the record at `state: starting`, and the lift stalls the full 133 s ready budget before blaming the timeout instead of ENOENT

- **Order:** 110
- **Scope:** [03-cli](../../reference/03-cli.md) § The Codex holder, `lib/codex-session.js`, `lib/codex-rpc.js`, `lib/driver-codex.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`holdMain` (lib/codex-session.js:644) spawns the app-server child at line 670 — `const child = spawn(record.bin, ['app-server', '--stdio'], { cwd: record.cwd, env: record.childEnv ?? env, stdio: ['pipe', 'pipe', 'pipe'] })` — and attaches only `child.stderr.on('data', …)` (line 712) and `child.on('exit', …)` (line 820). `grep -n "on('error'" lib/codex-session.js lib/codex-rpc.js lib/codex-hold.js` finds listeners only on the holder-socket client (line 286) and the unix server (line 905); nothing on the app-server child or its `stdin`/`stdout`. A spawn that never starts emits `error` and no `exit`, so nothing here catches it, and `CodexRpc`'s `outgoing.write` (lib/codex-rpc.js:24) writes to `child.stdin` with no error listener either.

Reproduced today (HEAD cc1aca8): with a scratch `PROMPTOBUS_CODEX_HOME` and a record naming `bin: /nonexistent/codex-binary`, `node lib/codex-hold.js <record>` crashes with `Error: spawn /nonexistent/codex-binary ENOENT … Unhandled 'error' event`; the holder log holds exactly one line, `app-server pid undefined bin /nonexistent/codex-binary`, and no `failHold` patch (`state: 'failed'`) is ever written to the record. `startHolder` (line 325) runs this detached with `stdio: 'ignore'`, so the crash reaches nobody. `waitReady` (line 362) then polls until `readyMs(env)` — `preambleMs() + TURN_STARTED_TIMEOUT_MS`, 133000 ms today, matching docs/reference/03-cli.md § The Codex holder ("133 seconds with the default 3-second limit wait") — and `driver-codex.js:426-431` then refuses with "Codex thread did not lift (the holder did not confirm lift in 133000 ms)", naming the timeout instead of the ENOENT.

Reachable in practice: the shipped standalone host answers `resolveToolBin` with `{ ok: true, bin: name }` for any name at all (src/standalone.ts:302), so a `codex` binary missing from PATH under that host is never caught before the spawn; a binary can also vanish between resolve and lift, a race `lib/liftoff.js:59-67` already handles explicitly for the direct-run path ("the binary vanished between the check and launch"). The project already closes this exact trap one module away: `lib/model-routing/adapter-codex.js:305-318` attaches `child.on('error', …)` plus no-op `stdin`/`stdout` error listeners on its own app-server probe, citing the standalone host by name ("resolveToolBin may say ok about a binary that is not there … A pipe error with no listener is an uncaught exception that takes the whole command down"). The holder — the one process that must not die silently — has no equivalent.

## Work to do

- Add `child.on('error', (err) => failHold(`app-server did not start: ${err.message}`))` next to the existing `child.on('exit', …)` at codex-session.js:820 — `failHold` is already defined at line 807 and does the rest: `state: 'failed'` with the reason, kill, drop the holder lock, remove the socket.
- Attach no-op `error` listeners on `child.stdin` and `child.stdout` so a write to a dead app-server (CodexRpc's `outgoing.write`, lib/codex-rpc.js:24) raises a handled EPIPE, not an uncaught exception.
- Note the behaviour in docs/reference/03-cli.md § The Codex holder: a spawn failure ends the holder immediately with the reason on the record, not after the full ready budget.

## Out of scope

- The 133 s ready-budget value itself, and PB-39.1 (first turn fails after lifting) / PB-42 (activity watchdog for a running turn) — both assume a holder that is already up; this entry is only about the holder dying before it gets there.

## Verification

- A holder run against a record whose `bin` does not exist ends with `state: 'failed'` and the ENOENT message on the record within about a second, not 133 s; the driver's refusal (e.g. via `promptobus spawn`) quotes that reason instead of the ready-timeout wording.
- A fake app-server killed mid-write does not crash the holder process (no unhandled 'error' event in the holder log or exit trace).

## Triage — 2026-09-07

- **Track:** C — Codex session lifecycle.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/codex-session.js:644`, `lib/codex-rpc.js:24`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
