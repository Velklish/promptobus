# PB-123 · `successorVerdict` in `guard.js` exercises a decision path the Stop/SessionStart hook never takes, and `readEvent`'s stdin read has no deadline unlike the neighbouring successor probe

- **Order:** 540
- **Scope:** `lib/guard.js`, `test/promptobus-guard.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** PB-79

## Context

Verified against HEAD (v0.5.0). (1) `lib/guard.js:212-217` exports `successorVerdict(home, cwd, session, tasks = activeTasks(home), probe = probeContactPoint)`. `grep -rn successorVerdict lib src` finds only this declaration and two test call sites (`test/promptobus-guard.test.mjs:637, 733`, plus the import at `:33`). The production dispatcher `decide()` never calls it — it calls `successorHint` (`:238`) at all three of its call sites (`:274`, `:281`, `:300`). `successorHint` (`:238-244`) adds two gates `successorVerdict`/`deadOwnerItems` don't have: `sessionOnBus` (defined `:118`, called `:240`) and the per-session dedup `rememberSuccessorHints` (defined `:229`, called `:242`) — and it hardcodes `probeContactPoint` rather than accepting an injectable probe. So the counting-probe assertion at `test/promptobus-guard.test.mjs:637` ("live owner — probe is not called") measures a function the real hook never runs; the property it's meant to protect belongs to `successorHint`, which has no test-visible probe seam of its own. (2) `readEvent` (`lib/guard.js:59-70`): `if (stdin.isTTY) return {};` is the only gate, then an unbounded `for await (const chunk of stdin) raw += chunk;` — no timeout, no byte cap. The package states this discipline is required elsewhere in the same file: `lib/util.js:39-42`'s `PROC_TIMEOUT_MS` comment — "`spawnSync` has no default at all: without an explicit value a hung hook, npm, or npx stands forever together with the command that called it" — and the neighbouring successor probe already applies it (`lib/guard.js:92`: `const SUCCESSOR_PROBE_MS = 200;`, used at `:139`). Not tracked: `grep -rniE 'successorVerdict|readEvent|stdin.*hang' docs/backlog docs/archive` returns nothing.

## Work to do

- Give `successorHint` (`:238`) the injectable `probe` parameter (default `probeContactPoint`) that `deadOwnerItems` already threads through, point the two tests in `test/promptobus-guard.test.mjs` at `successorHint` instead of `successorVerdict`, then delete the now-unused `successorVerdict` export — or, if a direct-call test convenience is still wanted, keep it only as a thin wrapper `successorHint` calls.
- Race `readEvent`'s `for await (const chunk of stdin)` loop against a short deadline (`SUCCESSOR_PROBE_MS`'s 200 ms order, or its own named constant) and treat a timeout as an empty payload, exactly as a JSON parse failure is treated today; optionally cap the accumulated `raw` length.

## Out of scope

- Any change to what counts as a successor or to `deadOwnerItems`'s own logic — this only removes a test-only entry point and adds a deadline to an unrelated read.
- A measured incident of the stdin hang — none has been observed; the deadline is added on the strength of the package's own stated principle, not a reproduced failure.

## Verification

- After the change, `grep -rn successorVerdict lib src test` finds no reference (if deleted), and both relerant test cases in `test/promptobus-guard.test.mjs` call `successorHint` with an injected probe and still assert "probe is not called" for a live owner.
- A new `readEvent` test with a stdin stream that never closes and never writes returns `{}` within the deadline instead of hanging the test run.
- `npm test` stays green.

## Triage — 2026-09-07

- **Track:** W — Guard and warden delivery.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/guard.js:212`, `test/promptobus-guard.test.mjs:637`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
