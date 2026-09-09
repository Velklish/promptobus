# PB-63 · `migrate` never removes `migrated.json` after cleanup, so a legacy store that reappears at the same path is deleted instead of triggering the side-by-side refusal

- **Scope:** `src/migrate.ts` (`migrateLocked`, `preflight`, `markOf`), `lib/store.js` (the legacy-directory warn line), [02-host](../../reference/02-host.md) § `legacyLayout()`, `test/promptobus-migration.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none
- **Taken:** 2026-09-09

## Context

Current code, promptobus v0.5.0, HEAD cc1aca8, dist/ built and clean tree. `src/migrate.ts:56` names the mark (`const MARK = 'migrated.json'`); it is written into the temp root at `src/migrate.ts:390` (`writeJsonAtomic(path.join(temp, MARK), {...})`), travels into `.promptobus` with `renameSync(temp, target)` at line 398, and is removed **nowhere**: neither on the normal path after `rmSync(legacyHome, { recursive: true, force: true })` at line 406, nor on the resume path's identical call at line 367. `grep -rn "migrated.json" src lib test docs bin skills templates` finds exactly three hits (the header comment, the `MARK` constant, and one comment in test/promptobus-ambient.test.mjs) — nothing in the package ever deletes the file.

`preflight` (`src/migrate.ts:223` onward) reads the mark at line 247 and treats a match as license to resume, **before** the side-by-side refusal at line 251:

    if (markOf(target)?.from === legacyHome) { plan.needed = true; return plan; }
    plan.refusal = `both bus stores sit side by side: the new ${target} and the former ${legacyHome}. ...`;

So as long as a directory exists at the legacy path the mark names, the refusal is unreachable and `migrateLocked` takes the resume branch, which deletes whatever is currently at `legacyHome` and returns.

Reproduced end to end against the built package with layout `{ rel: '.agents/a2a' }` — the exact layout consumer-cli declares (`LEGACY_REL = '.agents/a2a'` in `cli/lib/promptobus/legacy-layout.js`, used at `cli/lib/promptobus/ati-host.js:256`):

    run 1 — one legacy task migrates: {"moved":true,"resumed":false,"tasks":["t20260101-000001"]}; `.promptobus/migrated.json` is left holding {"from":"<root>/.agents/a2a","tasks":1}; the legacy directory is gone.
    legacy store recreated at the same path with a second task carrying an inbox message (a rollback, a restored backup, an old clone re-synced).
    preflight -> {"needed":true,"refusal":null} — the mark still matches.
    run 2 — {"moved":true,"resumed":true,"tasks":[]}; the legacy directory is deleted; the new store still holds only t20260101-000001. The second run's task and its message are gone, with no backup and no refusal.

The loss is not silent but is worse than silent: `lib/store.js:153-156` prints `bus: former directory <from> is gone — the move was finished by a previous run` — asserting a previous run finished the move, over a directory this run just destroyed with fresh content in it.

No upstream guard exists: consumer-cli declares the layout unconditionally and neither `doctor` nor `lib/store.js` checks for a reappeared `.agents/a2a`. No test covers it either: `test/promptobus-migration.test.mjs` covers the crash-window resume and a repeat on an already-transferred workspace, but not a legacy store reappearing after a completed migration; `grep -rn "side by side" test docs` finds nothing — the refusal itself has neither test nor reference documentation.

Live exposure: `/Users/kim.p/AtiWorkspace/workspace/.promptobus/migrated.json` holds `{"from":"/Users/kim.p/AtiWorkspace/workspace/.agents/a2a","at":"2026-09-02T22:09:12.305Z","tasks":72}` today, and `.agents/` is the regenerated zone — a rollback of the `modules.lock` pin to a pre-cutover consumer-cli (a routine move in this workspace) recreates exactly that path.

The mark's own header comment (`src/migrate.ts:18-28`) justifies it only as the closer of the window between the switch and the cleanup ("It is missing — `.promptobus` came from somewhere else, and that is the very case the refusal was introduced for") — an argument for removing it once that window closes, not for keeping it afterward.

## Work to do

- After `rmSync(legacyHome, ...)` succeeds — on the normal path (line ~406) and the resume path (line ~367) — add `rmSync(path.join(target, MARK), { force: true })`, in that order: if the legacy removal throws, the mark must survive so the next run still resumes.
- If the record of a completed migration is worth keeping afterward, rename `migrated.json` to a name `markOf`/`preflight` do not accept as a resume token (e.g. `migrated-from.json`) once cleanup finishes, so the historical fact survives without re-arming the resume path.
- Cover it in test/promptobus-migration.test.mjs: after a completed migration, recreate the legacy store at the same path with a task, and assert that `preflight` returns the "both bus stores sit side by side" refusal and that `migrate` throws a `GateError` touching neither root; keep the existing crash-at-switch resume test green (its crash lands before cleanup, so the mark is still in place there).
- State the resulting rule in docs/reference/02-host.md beside `legacyLayout()`: the mark lives only between the switch and the cleanup, and a former store at the same path after cleanup is a refusal, not a resume.

## Out of scope

- consumer-cli' own layout declaration or a doctor/sync check for a reappeared `.agents/a2a` — that is the consumer side; this entry is the package-side fix that makes reappearance safe for every consumer.
- Any change to the mark's shape, the assembly step, or the atomic rename that follows it.

## Verification

- New test in test/promptobus-migration.test.mjs: legacy store recreated after a completed migration triggers the side-by-side refusal, and neither root is touched. `npm test` green.
- Existing crash-at-switch resume test stays green.
- Manual: on a scratch workspace, run migration to completion, recreate the legacy directory with a task, run migrate again — the command refuses naming both stores, nothing is deleted.

## Triage — 2026-09-07

- **Track:** S — Store integrity and public engine.
- **Priority:** P0.
- **Evidence level:** source/definition review at `1e0401a`, including `src/migrate.ts:56`, `lib/store.js:153`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Priority: potential data loss. Removing the marker after future cleanup is insufficient for installations already carrying an old completed marker. Acceptance must also seed that existing-marker state, recreate the legacy store with new data, and prove no new data is deleted. Do not treat a matching path alone as proof that cleanup may resume.
