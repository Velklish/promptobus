# PB-118 · done() calls listTasks(home) three times per invocation (sweepWorktrees, sweepParticipantSecrets, sweepJournals/pruneCandidates), re-parsing every task journal each time and repeating any broken-task warning up to three times

- **Order:** 170
- **Scope:** `lib/done.js` (`sweepWorktrees`, `sweepParticipantSecrets`), `lib/prune.js` (`sweepJournals`, `pruneCandidates`), `lib/store.js` (`listTasks`, `withTaskCache`)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Verified at commit `cc1aca8` (v0.5.0), against the live workspace home (`<workspace>/.promptobus`, 91 tasks today).

`done()` calls three functions that each independently walk `listTasks(home)`:
- `sweepWorktrees(home, snapshot, host)` — called at `lib/done.js:367`, walks at `:145`.
- `sweepParticipantSecrets(home, snapshot)` — called at `:368`, walks at `:212`.
- `sweepJournals(home)` (`:385` → `lib/prune.js:138` → `pruneCandidates(home, days)` at `prune.js:70`), which walks a third time.

`listTasks(home)` (`lib/store.js:444-451`) does a fresh `readdirSync` + parse + schema-validate of every `task.json` under `tasks/` on every call, and unconditionally `warn()`s once per broken/unreadable task (`:448-451`) — so a corrupt journal present at run time would print that warning up to three times in one `promptobus done`, not once.

`store.js` does define a memoization mechanism, `taskCache`/`withTaskCache` (`:348-359`), but it is never invoked anywhere outside its own definition and export (`grep -rn withTaskCache lib/ bin/` finds only the definition and the export list at `:1008`) — it wraps nothing in `done.js`'s three sweeps.

The asymmetry between the two `done.js` sweeps is already visible in the code: `sweepWorktrees` short-circuits per task via a persisted `worktreesSwept` mark (`:151`, with the comment at `:147-150`: "without the mark the cost of cleanup would grow with run history"), but that mark only skips the per-participant git/worktree work inside the loop — it does not skip the `listTasks` parse itself, so even `sweepWorktrees` pays the full parse every call. `sweepParticipantSecrets` has no equivalent mark at all (only `if (meta.status !== 'done') continue;` at `:213`).

Measured directly in this session (three consecutive `listTasks(home)` calls on the live 91-task home): 58ms cold, then 10ms, then 5ms — confirming the repeated-parse cost is real, if individually small; `lib/prune.js:13-15`'s own comment records 54 tasks on 2026-08-30, so the home has grown from 54 to 91 in about a week and the cost of three walks grows with it.

The neighbouring comment inside `sweepParticipantSecrets` (around `done.js:217-223`) measures its own per-task session snapshot at 0.06ms/task on a 20-task home — small next to the `listTasks` cost, and that loop already short-circuits cheaply once a participant's files are gone. So the fix with the clearest payoff is sharing one `listTasks(home)` result across the three walks; giving `sweepParticipantSecrets` its own persisted mark like `worktreesSwept` is a separate, smaller-payoff idea.

## Work to do

- In `done()`, call `listTasks(home)` once and pass the resulting array into `sweepWorktrees`, `sweepParticipantSecrets`, and into `sweepJournals`/`pruneCandidates` (accepting an optional pre-fetched list there, defaulting to calling `listTasks` itself so the standalone `prune` CLI entry point is unaffected).
- Note beside the `worktreesSwept` comment (`done.js:147-150`) that the mark protects only the per-participant work, not the shared `listTasks` walk, now that the walk is shared once per `done()` call.

## Out of scope

- Giving `sweepParticipantSecrets` its own persisted "swept" mark analogous to `worktreesSwept` — its own measured cost (0.06ms/task, plus an existing cheap short-circuit) is smaller than what sharing the `listTasks` call already saves, so it is left as a separate, lower-priority idea rather than bundled here.
- Wiring `withTaskCache` more broadly across the codebase — this only removes the specific triple walk inside `done()`.

## Verification

- A test on a workspace with a handful of closed tasks and a stub `listTasks` that counts its calls: one `promptobus done` invocation calls it once, not three times.
- With one corrupted `task.json` present, `promptobus done` prints the broken-task warning once, not up to three times.

## Triage — 2026-09-07

- **Track:** X — Deferred structural work.
- **Priority:** P3.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/done.js:367`, `lib/prune.js:138`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.

## Returned to the queue, 2026-09-12

**The return condition has fired:** the store and telemetry changes are accepted (archived). The bounded operation-count measurement the condition also names **is the work of this card**, not a precondition for taking it.
