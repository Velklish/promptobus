# PB-141 · home.mjs deletes the CLAUDE_CONFIG_DIR the runner set for a suite file's own child processes, and the verdict that claims to guard it runs on a probe that never exercises the deletion

- **Scope:** `test/hygiene.mjs`, `test/home.mjs`, `test/check.mjs`, `test/run.mjs`, `test/runner.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`test/hygiene.mjs:277` is the unconditional else-branch of `applyHygiene`'s home handling:
```js
if (home) {
  for (const name of HOME_VARS) env[name] = home;
  env[CONFIG_DIR_VAR] = path.join(home, '.claude');
} else {
  delete env[CONFIG_DIR_VAR];   // line 277
}
```
Compare the seal branch two lines below (`hygiene.mjs:300`), which preserves an already-standing value instead of dropping it: `else if (env[SEAL_VAR] && existsSync(env[SEAL_VAR])) env.PATH = env[SEAL_VAR];`. The home branch has no such preservation.

`test/run.mjs:130-145` (`testEnv`) builds a per-file home for every child of a run and calls `applyHygiene({ ...process.env, ... }, { home, seal: SEAL_DIR })`, which sets `CLAUDE_CONFIG_DIR = path.join(home, '.claude')` in the env it hands the child.

`test/home.mjs:69-71` runs a second `applyHygiene` inside that same child, at module load, for every `test/*.test.mjs` that imports `check.mjs` (which imports `home.mjs` at `check.mjs:38`) — 52 of the suite's files do. It decides whether to divert home by checking `HOME_VARS.some((name) => process.env[name] === REAL_HOME)`, where `REAL_HOME = os.userInfo().homedir` — the real system home, read from the passwd record, ignoring `$HOME`. Inside a runner-spawned child, `process.env.HOME` is already the per-file directory `run.mjs` just set, not `REAL_HOME`, so the check is false, `home` is `null`, and `applyHygiene(process.env, { home: null })` hits the `delete env[CONFIG_DIR_VAR]` branch — clobbering the value `run.mjs` set moments earlier for that same child's own further subprocesses.

Reproduced directly: `HOME=<tmp> CLAUDE_CONFIG_DIR=<tmp>/.claude node -e "import('./test/home.mjs').then(() => console.log(process.env.CLAUDE_CONFIG_DIR ?? '(dropped)'))"` prints `(dropped)`.

The verdict that reads as guarding this — `test/runner.test.mjs:228`, `check(': CLAUDE_CONFIG_DIR is diverted into the run directory — stall parse does not read a person home', ...)` — runs against a probe file written at `runner.test.mjs:150-153` (`b-dom.test.mjs`) that imports only `node:os`, never `./check.mjs` or `./home.mjs`. So the probe only checks that `run.mjs` sets the variable for the child's initial env; it never runs the second `applyHygiene` pass that deletes it, and so never exercises the actual bug.

Current impact is muted by coincidence: `lib/driver-claude.js:285` (`claudeHome`) falls back to `path.join(homedir(), '.claude')` when `env.CLAUDE_CONFIG_DIR` is absent, and `homedir()` (from `node:os`) already resolves to the same diverted `HOME` inside a runner child — so a suite file that spawns the real CLI still lands in its own sandboxed config dir today, just via a different variable than the one that was supposed to carry it.

## Work to do

- Mirror the seal branch's preserve pattern in `applyHygiene`'s home handling: when `home` is not given but `env[CONFIG_DIR_VAR]` is already set to a value under a live diversion, keep it instead of deleting it.
- Make the `runner.test.mjs` probe file import `./home.mjs` (or `./check.mjs`) so the existing verdict at line 228 actually exercises the second `applyHygiene` pass, not just `run.mjs`'s.
- Update the header comment on `applyHygiene` (and `test/home.mjs`'s own header, which states the contract "without a home — dropped") to describe the corrected behaviour.

## Out of scope

- The `claudeHome()` fallback in `lib/driver-claude.js` — it is not wrong today and this entry does not ask to change it.
- PB-2.2 and PB-2.3's fixes (hand-run files not diverting home; a stale comment) — this is a different gap in the same file family, not a regression of either.

## Verification

- The reproduction above (`HOME=<tmp> CLAUDE_CONFIG_DIR=<tmp>/.claude node -e "import('./test/home.mjs')..."`) prints the preserved path instead of `(dropped)` after the fix.
- The updated `runner.test.mjs` probe (importing `home.mjs`) goes red against the pre-fix code and green after.
- `npm test` stays green.
