# PB-122 · `run()` traces one environment and plans the launch with another, so on Windows a caller-supplied PATH is ignored and the suite's escape-gate evidence is empty by construction

- **Order:** 40
- **Scope:** `lib/exec.js`, `lib/worktree.js`, `lib/liftoff.js`, `test/promptobus-copy.test.mjs`, [02-host](../../reference/02-host.md)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Verified against HEAD (v0.5.0). `lib/exec.js:173-181`: `run()` calls `trace(cmd, options)` — which uses `options.env ?? process.env` (`:162-171`) — then calls `planRun(cmd, args)` with **no third argument** (`:175`), so `planRun`'s destructured default `env = process.env` (`:91`) always wins and `options.env` never reaches path resolution. Two real callers rely on `options.env` reaching the launch: `lib/worktree.js:374` (`runProc('npm', NPM_CI_ARGS, { cwd, timeout, ...(env ? { env } : {}) })`, documented at `:368-370` as "an ENOENT-check seam: spawnSync without an explicit env takes the process PATH... hiding npm from process.env is not enough") and `lib/liftoff.js:59-64` (`run(tool.bin, argv, { cwd, env, ... })`). `planRun` no-ops on non-win32 (`:92`: `if (platform !== 'win32') return { ok: true, file: cmd, args, verbatim: false };`), and the CI matrix (`.github/workflows/*.yml`: `os: [ubuntu-latest, macos-latest]`) never runs win32, so the bug is fully latent — on macOS/Linux the kernel resolves PATH from the real `options.env` forwarded straight into `spawnSync`. On win32, `resolveCommand`/`comSpec` inside `planRun` would search `process.env.PATH`/`.ComSpec` instead of the caller's, so `worktree.js`'s documented ENOENT seam (hiding npm from a caller-built env) would not fire — npm would still resolve off the parent's PATH. Separately, `wouldResolve` (`:148-160`, used only by `trace`) is POSIX-shaped: no PATHEXT walk, and it requires `statSync(file).mode & 0o111`, meaningless on Windows — so on win32 every trace line reads `(unresolved)`, and the escape gate that consumes it (`test/run.mjs:543`, filtering out `(unresolved)` lines) would report a clean run with zero evidence rather than proof nothing escaped. `test/promptobus-copy.test.mjs` already unit-tests `resolveCommand`/`planRun`'s win32 branches directly with an explicit `env`, bypassing `run()` entirely, so it does not catch this divergence. Not tracked: `grep -rniE 'win32|windows' docs/backlog/queue docs/backlog/deferred` only hits `PB-37.1`/`PB-37.2`/`PB-24.1`, all about rate-limit "windows", unrelated to the OS; no ADR excludes Windows from scope.

## Work to do

- Pass the environment through in `run()`: `const plan = planRun(cmd, args, { env: options.env ?? process.env });` (`lib/exec.js:175`).
- Give `wouldResolve` the same PATHEXT/platform handling `resolveCommand` already has — on win32 delegate to `resolveCommand(cmd, { platform, env })` and keep the POSIX exec-bit walk only for non-Windows.
- Add two win32 cases to `test/promptobus-copy.test.mjs` mirroring the existing `resolveCommand`/`planRun` cases, exercising the same call shape `run()` now makes (`planRun` with an explicit `env` that omits a directory present in `process.env.PATH`).

## Out of scope

- Adding Windows to the CI matrix — a separate, larger decision; this only makes the existing win32 branches correct for when that happens or when the package runs on a Windows host today outside CI.
- Any change to POSIX behaviour — `planRun` and `wouldResolve` already resolve correctly there.

## Verification

- New `test/promptobus-copy.test.mjs` cases: `planRun(cmd, args, { platform: 'win32', env: envWithoutSomeDir })` resolves against the supplied `env`, not `process.env` — red before the fix, green after.
- `wouldResolve`/`trace` under `platform: 'win32'` (forced the same way the existing tests force it) no longer returns `(unresolved)` for a binary that exists under a PATHEXT extension.
- `npm test` stays green; the `test/run.mjs` escape-gate assertion is unaffected on the CI platforms it actually runs on.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/exec.js:173`, `lib/worktree.js:374`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
