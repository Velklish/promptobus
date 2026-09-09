# PB-136 · None of the ADR-004/005 overlay blocks — balance, nearLimit, defaults, account — appears in the schema-versus-grammar parity corpus, and `account` has no shape or reference test at all

- **Scope:** `lib/model-routing/validate.js`, `schemas/model-routing/overlay.schema.json`, `test/model-routing-catalog.test.mjs`, [reference/03](../../reference/03-cli.md) § Catalog and overlays
- **Created:** 2026-09-06
- **Dependencies:** PB-155
- **Taken:** 2026-09-09

## Context

lib/model-routing/validate.js hand-writes grammar blocks for `balance` (line 405), `nearLimit` (420), `defaults` (440) and `account` (452), each mirrored in schemas/model-routing/overlay.schema.json at `balance`:74, `nearLimit`:92, `defaults`:110, `account`:122. The file's own header (validate.js:9-15) states why the two descriptions are kept in sync at all: "Two descriptions of one contract drift, so a parity check on shared documents lives in test/model-routing-catalog.test.mjs — edit one, edit the other, or the red comes from there." The `overlayDocs` corpus that check runs (test/model-routing-catalog.test.mjs:1226-1265, ~40 documents) names none of `balance`, `nearLimit`, `defaults` or `account` as a top-level key — the one string hit for "balance" (line 1229, `weights: { balanced: {...} }`) is the `balanced` strategy name inside `weights`, not the ADR-004 `balance` block. `account` has exactly two other uses in the suite: a happy-path overlay at test/model-routing-command.test.mjs:431 and a merge test at test/model-routing-catalog.test.mjs:772 — neither is in the parity corpus, and neither exercises the `account.<harness>` unknown-harness error path (validate.js:961-966, deliberately raised as an error rather than a warning "because the answer is display only, so a misspelt one would sit in a file forever"). `grep -rli parity nearLimit overlayDocs` across docs/backlog and docs/archive surfaces PB-32 (near-limit signal/strategy default) and PB-37 (calibrate/ADR-005) — both about the runtime behavior of these blocks, not about this test-coverage gap; nothing tracks the gap itself.

## Work to do

- Add a lawful and an unlawful document for each of `balance`, `nearLimit`, `defaults` and `account` to the `overlayDocs` corpus in test/model-routing-catalog.test.mjs, mirroring the existing entries for `qualityFloor`/`deny`/`payg`.
- Add one `validateLayers` (or `checkOverlayShape`) case exercising the `account.<harness>` unknown-harness error path, since no test names it today.
- No change to validate.js or overlay.schema.json themselves — this closes a gap in the regression gate, not a behavior.

## Out of scope

- `byRole` and `flags` blocks under `deny`/`allow` — the evidence and the finder's own fuzz probe scoped this finding to the four ADR-004/005 blocks named in the title; their corpus coverage is a separate question.
- Any change to the account/balance/nearLimit/defaults grammar or schema — a 40-document fuzz already run over exactly these blocks found zero divergence today; the gap is in the gate, not in the code.

## Verification

- `npm test` — the widened `overlayDocs` corpus and the new `validateLayers` case pass.
- Mutation probe: introduce a one-field divergence between validate.js's `account` block and overlay.schema.json's `account` block (e.g. change `HARNESS_RE` in one but not the other) — the widened parity test goes red; today's suite stays green under the same mutation.

## Triage — 2026-09-07

- **Track:** R — Routing policy, overlays and availability.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `test/model-routing-catalog.test.mjs:1226`, `test/model-routing-command.test.mjs:431`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
