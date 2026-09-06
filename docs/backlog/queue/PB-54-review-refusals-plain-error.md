# PB-54 · Eight layout and argument refusals in `promptobus review` throw a plain `Error`, so the CLI prints a stack trace and a legal refusal reads as an internal crash

- **Order:** 990
- **Scope:** `lib/review.js`, `lib/cli.js`, `test/promptobus-review.test.mjs`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-51

## Context

`lib/review.js` throws a bare `Error` at eight sites — lines 142, 152, 154, 159, 181, 372, 384 and 524 — while four sibling refusals in the same file (163, 168, 192, 418) throw the `GateError` already imported at line 10. `lib/cli.js`'s top-level catch (369-378) treats only `status`, `ResolveError`, `GateError`, `PromptobusError` and `HostResolveError` as expected before printing `e.stack` (line 378) and then `fail(e.message)`.

Reproduced now on HEAD cc1aca8 (promptobus 0.5.0): `node bin/promptobus.js review` run outside a git repository prints the message, then five stack frames rooted at `planReview (lib/review.js:142:11)`, then the `✖` line. `promptobus review --strategy balance` from the same place takes the routed twin throw and prints frames rooted at `lib/review.js:524:13` instead — this path is taken whenever `--strategy` is passed or `defaults.strategy` is recorded, and it is an eighth site, not a seventh. The neighbouring commands (`status --task nope`, `dismiss`, `history`, `prune`, `done`) print one `✖` line only, because they raise `GateError` or call `fail()`.

The rule these eight throws break is written down twice elsewhere in the same codebase: `lib/done.js:316-318` ("The refusal prints via `fail()`, not a throw: the top CLI catch prints `e.stack`, and a legal refusal would arrive as a sign of an internal CLI break") and `lib/store.js:469` ("thrown as a `GateError`: a bare `Error` is printed with a stack…"). `docs/reference/03-cli.md` documents the same boundary for the sibling `limit-hit-at-start` code.

No test binds the error class: `test/promptobus-review.test.mjs` (lines 191, 206, 209, 1327, 1336, 1613) asserts message text and exit status only, so replacing a `GateError` with a plain `Error` anywhere would still pass.

## Work to do

- Change `throw new Error(...)` to `throw new GateError(...)` at `lib/review.js` lines 142, 152, 154, 159, 181, 372, 384 and 524 — `GateError` is already imported at line 10 and is already the class every sibling refusal in this file uses
- Add one case to `test/promptobus-review.test.mjs` that runs `review` with no path and asserts the output contains no `    at ` stack frame, so the class is held by the suite and not only by the comments in `done.js` and `store.js`

## Out of scope

- `lib/spawn.js` (seven `throw new Error` sites) and `lib/status.js` (one) — the same audit is owed there but belongs to a separate entry
- Any change to the refusal messages themselves — only the thrown class changes

## Verification

- `node --test test/promptobus-review.test.mjs` stays green
- `node bin/promptobus.js review` from outside a git repository (or `--strategy balance` from the same place) prints the `✖` line with no stack trace beneath it
- `grep -n "throw new Error" lib/review.js` returns no results

## Triage — 2026-09-07

- **Track:** L — Spawn, review and command guidance.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/review.js:142`, `lib/done.js:316`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
