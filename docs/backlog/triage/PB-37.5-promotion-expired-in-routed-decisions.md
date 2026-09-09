# PB-37.5 · Decide whether promotion-expired should also reach routed decisions, which today route on the expired band and say nothing

- **Scope:** `lib/model-routing/resolver.js` (`DECISION_WARNINGS`), `schemas/model-routing/decision.schema.json` (`$defs.warningCode.enum`), [03-cli](../../reference/03-cli.md) § Model routing (the warning table)
- **Created:** 2026-09-09
- **Dependencies:** none

## Context

Question raised by the PB-37.1 review (isolated reviewer, run `pb-run-0909-t20260909-132344`) and left to the owner. PB-37.1 made `promotion-expired` validate-only: `models validate` names a `quotaCost` promotion whose last observed date passed, but `resolver.js` filters decision warnings against `DECISION_WARNINGS`, which was not extended, so `spawn` and `review` route with the expired band and say nothing. PB-37.1's acceptance criterion names only `models validate`, so the change satisfies it — but the task's own context frames the damage in routing terms: `spendPenalty = balance.spendUnit × (quotaCost − 1) / 9` is exactly 0 at band 1 and `spendUnit / 9` at band 2, a real thumb on the scale under `economy` and inside `balance`.

## Work to do

- Decide (owner): keep the warning validate-only (the reminder is `models validate`; routed output stays quiet), or let it reach decisions. If the latter, three pinned places move together — the decision schema's `warningCode` enum, `DECISION_WARNINGS`, and the 03-cli warning table — because `test/model-routing.test.mjs` asserts the table and the enum are one list; the shipped catalog would then carry the two Gemini warnings into every routed decision until the rows are re-verified.
- Implement the decision with the parity test kept green.

## Out of scope

- The warning's content and the citation fields — PB-37.1.

## Verification

- For "reach decisions": a routed decision on the shipped catalog after 2026-09-06 carries `promotion-expired` for the two rows, and the docs↔schema parity test is green. For "validate-only": a sentence in 03-cli § Model routing states it, and nothing else changes.
