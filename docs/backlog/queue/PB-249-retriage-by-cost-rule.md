# PB-249 · Open cards re-triaged by the cost rule and the minor evidence rule

- **Order:** 600
- **Scope:** `docs/backlog/`, [ROADMAP](../../ROADMAP.md)
- **Created:** 2026-09-23
- **Dependencies:** PB-247 — minor evidence is required from v0.10.0

## Context

The finding cost rule (backslop v0.9.0, ADR-022 in backslop) and the required minor evidence (v0.10.0) are in force, and the open cards were never reviewed under them: on 2026-09-23 no card filed before this run carries a Cost field. The precedent is the aivals backlog review of 2026-09-19.

## Work to do

- Give every queue and triage card a Cost field (`critical` / `major` / `minor`) by the backlog rules' scale; verify each checkable claim against the current tree and restate an unverified one as an assumption.
- Move `minor` and hypotheses without evidence to `minor/` with an Evidence section.
- Merge duplicates into the receiving card.
- Deferred cards: a return condition that has fired moves the card to the queue with a label; otherwise it stays.
- Cards whose subject is gone: a list of rejection candidates with evidence; the owner rejects.
- Order the queue by cost, `critical` first; cut minor batches by area — ten or more entries, or an area the next run touches.

## Out of scope

- Doing the cards, and any rejection without the owner.

## Verification

- `lint` green; `status` before and after with counts per status; every queue card carries a Cost field.
