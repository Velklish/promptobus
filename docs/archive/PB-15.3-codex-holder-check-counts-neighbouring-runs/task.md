# PB-15.3 · The Codex holder check counts processes of a neighbouring run and reddens on them

- **Scope:** [01-overview](../../reference/01-overview.md)
- **Created:** 2026-09-05

## Context

`test/promptobus-driver-codex.test.mjs` decides "after a lift refusal there are no holder processes" by comparing two machine-wide `pgrep` snapshots (lines 392–410):

```js
function pgrep(pattern) { return spawnSync('pgrep', ['-f', pattern], …); }
const beforeApp = pgrep('app-server --stdio');
…
const extraApp = pgrep('app-server --stdio').filter((p) => !beforeApp.includes(p));
```

The pattern is not scoped to this run, this worktree or this sandbox, so **any** `app-server --stdio` that starts between the two snapshots reads as a holder this refusal leaked. That is exactly what a second checkout does: the adapter tracks of this series run their suites in parallel worktrees on one machine.

Measured on 2026-09-05, `npm test` in the `adapter-claude` worktree:

```
✖ : after a lift refusal there are no holder processes — hold  · app 60504
✖ promptobus-driver-codex.test.mjs — failed (code 1)    (55/56 in that file, 41/42 files)
```

with, at the same moment,

```
$ pgrep -fl adapter-codex-t20260905-091407
75950 …/promptobus-model-routing-v1-in-adapter-codex-t20260905-091407/test/promptobus-e2e.test.mjs
```

Re-run of the same file alone afterwards: `56/56 passed`, exit 0. The `adapter-claude` branch touches no Codex code — `lib/driver-codex.js` and `lib/codex-session.js` do not import `lib/liftoff.js`, the only shared launcher that branch changed (`grep -n liftoff lib/driver-codex.js lib/codex-session.js` finds nothing).

The neighbouring `hold` count is empty in the diagnosis and only `app` is named, so the leak that reddens is the app-server one; the same reasoning applies to `codex-hold.js`.

## Work to do

- Scope the two patterns to this run — the sandbox path, the run's `TMPDIR`, or an environment marker the holder carries — so the check judges its own processes. The suite already isolates by sandbox everywhere else; this is the one verdict that reads the whole machine.
- If a machine-wide read is genuinely wanted, the check must at least exclude processes whose command line names another checkout, and say in its diagnosis which run it thinks the process belongs to.

## Out of scope

- The refusal path itself, which is correct: the file's own re-run is green.
- The socket sweep, which has its own prefix list.

## Verification

- Start a second `npm test` in another worktree of the same repository, then run `node test/promptobus-driver-codex.test.mjs`: today it can go red, and after the fix it does not.
