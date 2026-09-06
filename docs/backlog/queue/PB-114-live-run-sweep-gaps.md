# PB-114 · The live-run sweep is half-built: two sandbox prefixes are on no sweep list while the comment claims they have their own, the leftover verdict has no age or ownership cut-off so one crashed run reddens every later run, and two of three callers discard the `refused` list

- **Order:** 410
- **Scope:** `scripts/live-mixed.mjs`, `scripts/live-codex.mjs`, `scripts/live-e2e.mjs`, `scripts/live-cursor.mjs`, `scripts/live-canary.mjs`, `scripts/canary-runs.mjs`, `test/tmpdir-sweep.mjs`, `test/tmpdir-sweep.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** PB-67, PB-68, PB-69

## Context

Verified at commit `cc1aca8` (v0.5.0). Three separate gaps in the same sweep mechanism.

(1) No age cut-off on the run-directory verdict. `scripts/live-mixed.mjs:495-497`:
```
const tmpLeft = listing(tmpdir()).filter((n) => n.startsWith(RUN_PREFIX));
check('no run directories left in $TMPDIR after the loop',
  tmpLeft.length === 0 && !existsSync(SB), ...)
```
`RUN_PREFIX` is `'promptobus-live-mixed-run-'` (line 148) with no birth-time filter, so a directory left by any earlier interrupted `live-mixed` run matches and reddens this run's verdict too. The sibling `live-canary.mjs` already solves this: `bornAfter(file)` (lines 116-121, comparing `birthtimeMs`/`mtimeMs` against the run's own start time) is applied to both its leftover checks (lines 415, 418). The comment right above the check (`live-mixed.mjs:489-494`) names the gap ("past-run directories cannot be subtracted by one current pid") without closing it.

(2) Two live-run sandbox prefixes have no sweep at all. `scripts/live-codex.mjs:85` and `scripts/live-e2e.mjs:76` create sandboxes `promptobus-live-codex-` / `promptobus-live-e2e-` via `makeSandbox`, removed only in a `finally` that a crash or Ctrl-C never reaches; neither file imports `canary-runs.mjs` (confirmed by grep — zero hits for `sweepPreviousRuns`/`canary-runs` in either file). The exclusion comment in `test/tmpdir-sweep.mjs:78-81` claims otherwise: "`promptobus-canary-`, `promptobus-release-gates-`, `promptobus-live-e2e-`, `promptobus-live-cursor-` ... have their own sweep and their own thresholds" — `promptobus-live-codex-` isn't even named there, and a repo-wide grep for `promptobus-live-e2e` finds only its `makeSandbox` call, this comment, a fixture name and one counting reference in `live-canary.mjs:414`, never a sweep. The sentinel that should have caught the gap only scans `test/`: `test/tmpdir-sweep.test.mjs:271 const SCAN = [here];`, while the socket sentinel a few dozen lines below scans both directories (`:311 const SOCK_SCAN = [here, path.join(here, '..', 'scripts')];`).

(3) Two of the three `sweepPreviousRuns` callers drop the `refused` list. `canary-runs.mjs:49-52` documents it: "directories the sweep was not allowed to remove ... are pushed here ... promising a removal that did not happen is a lie". Only `live-canary.mjs:135-138` passes and prints `refusedRuns`; `live-cursor.mjs:563` and `live-mixed.mjs:513` both call `sweepPreviousRuns(tmpdir(), { prefix: LOGS_PREFIX, current: KEPT_LOGS })` with no `refused` argument, so it silently defaults to `[]` (`canary-runs.mjs:54`) and the per-directory catch at `canary-runs.mjs:77` swallows the failure with nothing surfaced.

## Work to do

- Apply the same `bornAfter` birth-time cut-off `live-canary.mjs` already uses to `live-mixed.mjs`'s run-directory verdict (line 495), so a leftover from an earlier interrupted run no longer reddens the current one.
- Add a `sweepPreviousRuns` call for each of `promptobus-live-codex-` and `promptobus-live-e2e-` in `live-codex.mjs` and `live-e2e.mjs`, and correct the exclusion comment in `test/tmpdir-sweep.mjs:78-81` to name the prefixes it actually excludes and why.
- Widen `SCAN` in `test/tmpdir-sweep.test.mjs` to also cover `scripts/` (matching the socket sentinel's `SOCK_SCAN`), so a future live script with an unswept prefix is caught instead of passing silently.
- Pass a `refused` array into the `sweepPreviousRuns` calls in `live-cursor.mjs` and `live-mixed.mjs` and print it beside the swept-count line, the way `live-canary.mjs:138` does.

## Out of scope

- `canary-runs.mjs`'s sweep algorithm itself (age/keep thresholds) — this only wires existing callers into it correctly.
- `promptobus-release-gates-`, which the exclusion comment also names but which belongs to a script not present in this repository.

## Verification

- `node --test test/tmpdir-sweep.test.mjs` stays green after widening `SCAN`, and goes red if a new `scripts/*.mjs` sandbox literal is added without a matching sweep or `SUITE_PREFIXES` entry.
- Manual run: leave a stale `promptobus-live-mixed-run-*` directory in `$TMPDIR`, older than an hour, then run `live-mixed.mjs` — the "no run directories left" verdict passes.
- Manual run of `live-cursor.mjs` or `live-mixed.mjs` with a directory made unremovable under its logs prefix — the sweep line reports it as refused instead of staying silent.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `scripts/live-mixed.mjs:495`, `scripts/live-codex.mjs:85`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
