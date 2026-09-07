# PB-50 · Harness process launches go through `run` with neither `timeout` nor `maxBuffer`, so a wedged `claude agents --json` or `tmux` freezes the warden loop and every bus command that reads session state

- **Order:** 30
- **Scope:** [03-cli](../../reference/03-cli.md) § Guard and warden, `lib/exec.js`, `lib/util.js`, `lib/liftoff.js`, `lib/driver-claude.js`, `lib/driver-cursor.js`, `lib/cursor-persist.js`, `lib/warden.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`run` (lib/exec.js:173-181) forwards `options` straight into `spawnSync` and adds no `timeout` and no `maxBuffer` of its own. Only `runProc` (lib/util.js:47-55) supplies `timeout: PROC_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT`, and the comment directly above it states exactly this rule (lib/util.js:41-43): "`spawnSync` has no default at all: without an explicit value a hung hook, npm, or npx stands forever together with the command that called it."

Five bare `run(...)` call sites on the harness path skip both ceilings, confirmed with `grep -n` on HEAD cc1aca8:
- lib/liftoff.js:59 — the lift itself, `run(tool.bin, argv, { cwd, env, encoding: 'utf8', stdio: [...] })`
- lib/liftoff.js:202 — `run('claude', ['agents', '--json'], { encoding: 'utf8' })`
- lib/driver-claude.js:904 — `run('claude', ['stop', id], { encoding: 'utf8' })`
- lib/driver-cursor.js:131 (`tmux -V`), :1000 (`git init`), :1009 (`mcp enable`)
- lib/cursor-persist.js:315 — the shared `tmux()` wrapper every tmux read and paste goes through — and :1046 (`<agent> persist stop`)

The warden path is synchronous end to end through the second of these: `lib/warden.js:237` and `:246` call `snapshotOf(readTask(...).participants)` → `lib/drivers.js:68 snapshotOf` → `lib/driver-claude.js:790-791 inspect` → `bgSessions()`, which is what calls `run('claude', ['agents', '--json'], …)` at lib/liftoff.js:202. The warden's own `stdio` is `ignore` (lib/warden.js:231-233), so a wedged `claude agents --json` blocks the beat loop with no output at all — no postcards, no stall lines, no journal entry. `promptobus status` and `promptobus done` reach the same call through the same `snapshotOf`.

The `maxBuffer` half is milder: a reply over Node's default 1 MB kills the call, `r.status` is `null`, and every consumer already treats `bgSessions() === null` as liveness `unknown` — a state the engine explicitly models ("unknown is not death", lib/driver-claude.js:783-784) — so nothing breaks on it today, the state is simply lost silently.

Nothing documents the omission on purpose: the long comment above `bgSessions` (lib/liftoff.js:177-192) reasons in detail about the cache and never mentions a ceiling.

## Work to do

- Give `run` (lib/exec.js:173) the same defaults `runProc` already applies — `timeout: PROC_TIMEOUT_MS`, `maxBuffer: GIT_MAX_OUTPUT` — both overridable by the caller's own `options`, so `runProc`, lib/worktree.js and lib/spawn.js keep behaving exactly as today and no future call site can forget them.
- Check the two calls that may need a different ceiling before accepting the default: the lift at lib/liftoff.js:59 (a `--bg` registration, not the session's lifetime) and the registry read at lib/liftoff.js:202, measured at 0.34-0.41 s per lib/driver-claude.js:834-841 — a few seconds is plenty, not sixty.
- No consumer change is needed: a timed-out `run` already returns `error.code === 'ETIMEDOUT'`, which `bgSessions` already turns into `null` → `unknown`; `procTimedOut` (lib/util.js:59-61) is the existing predicate for a caller that wants to word the diagnosis.
- Note in docs/reference/03-cli.md § Guard and warden that no driver call on the beat path may block without a ceiling.

## Out of scope

- Choosing a shorter ceiling than the shared `PROC_TIMEOUT_MS` (60 s) for any individual call — this closes the "no ceiling at all" gap, not the size of the existing one.

## Verification

- A stand-in binary on PATH that sleeps past the ceiling, driven through `bgSessions({ fresh: true })`, returns `null` within the ceiling instead of hanging indefinitely — a test that reddens if the default is removed from `run`.
- `npm test` still passes: the call sites listed above keep their current behaviour on a fast, well-behaved binary.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/exec.js:173`, `lib/util.js:47`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Confirmed missing timeout in run(). Do not claim spawnSync has no default maxBuffer: the finding is the absence of an explicit project output budget. Keep ceilings configurable and distinguish synchronous registration time from a session lifetime.
