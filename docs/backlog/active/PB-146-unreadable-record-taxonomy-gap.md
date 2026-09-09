# PB-146 · The store's unreadable-record taxonomy differs between readers: listTasks flattens schema-version-unsupported into the same broken bucket as corruption, and a corrupt artifact answers artifact-not-found

- **Scope:** [reference/04-protocol](../../reference/04-protocol.md) § Artifacts, `src/v1/store.ts`, `src/v1/engine.ts`, `src/v1/artifacts.ts`, `src/v1/errors.ts`, `src/v1/messages.ts`
- **Created:** 2026-09-06
- **Dependencies:** PB-65
- **Taken:** 2026-09-09

## Context

`src/v1/store.ts:205-208` — `BrokenTask` carries only `{ id: string; note: string }`, no code. `listTasks` (`store.ts:211-230`) pushes into `broken` on any `readTask()` throw (line 226: `broken.push({ id: name, note: (e as Error).message })`), whether the underlying `PromptobusError.code` is `task-broken` (genuine corruption) or `schema-version-unsupported` (a record written by a newer mechanism than this reader — cured by starting a new session, not by fixing the journal). Confirmed both codes exist and are distinct: `test/v1-engine.test.mjs:1113-1119` puts a version-ahead record through `engine.readTask()` and asserts `e.code === 'schema-version-unsupported'`, with message text calling for 'a new session'; the sibling case at the same test (`test/v1-engine.test.mjs:1036-1041`, a genuinely truncated `task.json`) only asserts `.id` and a `/did not parse/` match on `.note` — no `.code` is ever checked on a `BrokenTask`, because the field does not exist.

`engine.ts:347-348` (`history()`) and `engine.ts:352-361` (`recover()`, no-task form) both derive their working set as `listTasks(home, cli).tasks` and iterate the parallel `broken` array with no way to separate the two causes. A workspace mid-`sync` — this very workspace's own load protocol runs mixed mechanism versions across sessions by design — hits exactly this: a bulk `recover()` or `history()` call cannot tell 'this task needs a newer session' from 'this task is actually damaged' without re-reading each broken id through `readTask()` by hand.

The taxonomy is not a hard problem: the codebase already solves it one layer over, at the message level. `src/v1/messages.ts` (`BrokenNote`, ~line 353) carries a `code: string` field explicitly, with a comment explaining why: 'Reason and place are split into fields, not glued into a string: the adapter assembles the text for a person, and a glue would force it to cut the string back with a regex.' `test/v1-engine.test.mjs:799` asserts `broken[0].code === 'schema-version-unsupported'` for `engine.read()`'s mailbox scan. `BrokenTask` lacks the field its sibling type already has and already tests for.

A second, related asymmetry lives in `src/v1/artifacts.ts`'s `readArtifact` (lines 199-222): a missing file (`artifacts.ts:199-205`) and a JSON-parse failure (`artifacts.ts:207-212`, after `isolateArtifact` has already moved the record to `broken/artifacts`) both `fail('artifact-not-found', ...)`. The second case has found, read, and physically relocated the record — it is not 'not found', it is corrupt and set aside — yet answers the same code as a record that never existed. This contradicts `src/v1/errors.ts:7`'s own stated doctrine: 'a consumer has no need to read [the message] ... and must branch on the code.' A schema-invalid record two lines later (`artifacts.ts:216-221`) does get its own `verdict.code` (`schema-invalid` or `schema-version-unsupported`); only the JSON-parse-failure branch is folded into `artifact-not-found`.

`grep -rli "BrokenTask\|schema-version-unsupported\|artifact-not-found" docs/backlog docs/archive` returns nothing — neither gap is tracked, and no ADR or comment defends either collapse as deliberate.

## Work to do

- Add `code: string` to `BrokenTask` (`src/v1/store.ts`), populated from the caught error's `PromptobusError.code` in `listTasks`, so `recover()` and `history()` (or their callers) can branch on 'needs a new session' versus 'is actually damaged' without a second read.
- Give the artifacts.ts JSON-parse-failure branch its own code (align it with `schema-invalid`, or introduce a dedicated `artifact-corrupt` code) instead of reusing `artifact-not-found` for a record that was found, read, and moved to `broken/artifacts`.
- Update `docs/reference/04-protocol.md` § Artifacts to state the corrected code for a corrupt (parsed-but-invalid or unparseable) artifact record, alongside the existing `artifact-integrity` note for a digest mismatch.
- Add a CHANGELOG entry under `## [Unreleased]` — this changes an error code a caller may already be matching on.

## Out of scope

- Changing the `schema-invalid` / `schema-version-unsupported` distinction itself, or anything about how `readTask()` or `readArtifact()` classify a record when called directly — both already report the right code to a direct caller. This is only about what survives into the bulk-scan (`broken`) results.
- Wiring `openEngine({ recover: true })` into any host — no current caller (`lib/store.js:210`) passes it; that is a separate question from whether the taxonomy `recover()` would report is correct.

## Verification

- A new `src/v1/*.test.ts` (or extension of `test/v1-engine.test.mjs`) case: a task journal written by a newer mechanism version and a genuinely truncated task journal, both present when `listTasks()` runs — `broken` lists two entries whose `.code` differ (`schema-version-unsupported` vs `task-broken`).
- A case for `readArtifact`: a metadata file containing invalid JSON is isolated to `broken/artifacts` and the thrown error's `.code` is no longer `artifact-not-found` (and differs from the code returned for a metadata file that is simply absent).

## Triage — 2026-09-07

- **Track:** S — Store integrity and public engine.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `src/v1/store.ts:205`, `test/v1-engine.test.mjs:1113`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
