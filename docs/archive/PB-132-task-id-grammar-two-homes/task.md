# PB-132 · TASK_ID_RE has two homes with different length bounds, so a task id the CLI-facing gate accepts is refused mid-operation as task-not-found by the store's own bound

- **Scope:** `src/protocol.ts`, `src/v1/model.ts`, `src/v1/layout.ts`, `src/migrate.ts`, `schemas/v1/task.schema.json`, `schemas/v1/message.schema.json`
- **Created:** 2026-09-06
- **Dependencies:** PB-66
- **Taken:** 2026-09-09

## Context

`src/protocol.ts:34` — `export const TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;` — unbounded. `src/v1/model.ts:25` — `export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;` — capped at 128 characters, matching the shipped schemas (`schemas/v1/task.schema.json:16`, `schemas/v1/message.schema.json:18`, both `"pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"`). The unbounded copy guards `requireTaskId` (`src/protocol.ts:90-93`, called from `lib/store.js:325, 329, 335, 340, 375, 407`) and migration's legacy-directory filters (`src/migrate.ts:277, 414`); the bounded copy guards every path the store builds, through `safeTask` in `src/v1/layout.ts:22-27`, which fails with code `task-not-found`. Reproduced live against the built package: `dist/index.js`'s `requireTaskId('a'.repeat(200))` returns normally (accepts it), but `lib/store.js`'s `taskFile(tmp, 'a'.repeat(200))` then throws `PromptobusError: invalid task id: «aaa…»` with `code: 'task-not-found'` — an oversized id passes the gate and is refused downstream as if it did not exist, which is the wrong diagnosis for the actual problem (length). The same pair also collides in migration: `src/migrate.ts:277` and `:414` accept a legacy directory name against the unbounded regex, then `src/migrate.ts:482`'s `mkdirSync(taskDir(temp, id), …)` calls the bounded `taskDir` from `v1/layout.ts`, which would throw `task-not-found` mid-migration for an oversized legacy name. Separately, `test/v1-validate.test.mjs:44-77` runs the hand-written validators and the shipped JSON Schemas over the same fixture set and asserts parity, but every fixture under `test/fixtures/v1/{valid,invalid}/*/*.json` is short — the longest string in any of them, measured just now, is 73 characters (`invalid/artifact/blob-outside.json`) — so the parity test does not exercise the task-id bound (128), nor the participant-id bound 64 (`model.ts:26` vs `schemas/v1/participant.schema.json:13`), the title bound 512 (`src/v1/validate.ts:143-144` vs `task.schema.json:20-21`), or the filename bound 255 (`src/v1/validate.ts:219` vs `artifact.schema.json:24`) — all four declared twice (validator plus schema) with nothing that would catch one side drifting.

## Work to do

- Delete the unbounded `TASK_ID_RE` in `src/protocol.ts:34` and import the bounded one from `src/v1/model.ts` (or register the pair in the existing literal-copy gate if a direct import is not wanted at that module level).
- Add four `invalid/*/…-too-long.json` fixtures under `test/fixtures/v1/` (task id 129 chars, participant id 65, title 513, filename 256) and a matching `valid` fixture at each exact bound, so `test/v1-validate.test.mjs`'s parity check actually exercises the four duplicated bounds.

## Out of scope

- The ids the CLI itself generates are unaffected — `newTaskIdentity` (`src/protocol.ts:154-161`) produces roughly 41 characters, well under either bound; this only closes the gap for a hand-typed `--task` value and for legacy migration.
- No change to the bound value itself (128) — only to making the two declarations agree and be tested.

## Verification

- Re-run the reproduction: `requireTaskId('a'.repeat(200))` must refuse the same way `taskDir`/`safeTask` does, with a code that names the actual problem rather than `task-not-found`.
- `npm test` stays green with the four new too-long / at-bound fixture pairs added to `test/fixtures/v1/`.

## Triage — 2026-09-07

- **Track:** S — Store integrity and public engine.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `src/protocol.ts:34`, `src/v1/model.ts:25`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
