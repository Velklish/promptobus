# PB-18 · Resolver: filtering, strategy scoring, reviewer rules, stable tie-break, explanation

- **Order:** 80
- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-13, PB-14

## Context

Stage 4 of the routing plan. The resolver is a pure function: role, concrete strategy, explicit constraints, merged policy (catalog plus overlays), availability snapshot and the list of live participants in, one decision with a full explanation out. Determinism is the contract — the same inputs give the same tuple, and every component of the score is visible.

## Work to do

- Filtering in this order: tuples from the catalog → allow/deny and explicit constraints → drop `unavailable` and `exhausted` → drop PAYG unless allowed → score → reviewer rules → tie-break. A model without a rating is not a tuple: it never enters the candidate list and is reported as a runtime row (ADR-003 step 3); the exclusion enum of `decision.schema.json` has no `unrated` code — a rated tuple the account does not expose is `model-not-in-inventory`. No candidates → a typed error the CLI turns into diagnostics before any write.
- Scoring with the PB-11 weight table; ratings normalised from 1–5; `quotaCost` inverted; `remaining` = minimum over applicable subscription windows, unknown → 50 % and minus 10 points; `unknown` availability allowed with penalty and warning.
- Extra rules: minus 5 per live participant on the same harness, capped at 20; reviewer quality floor 4 with soft fallback and warning; reviewer diversity bonus 5 for a harness or model different from the worker's; tie-break `effective score → confirmed availability → canonical priority → tuple id`. All numbers come from the merged policy, so overlays override them.
- Explanation: text for the terminal and the JSON of `decision.schema.json` (PB-12), listing every considered candidate with state, score components and exclusion reason.

## Out of scope

- Wiring into `spawn` / `review` and the `models` command — PB-21.
- Probes and cache — PB-14.

## Verification

- Tests per strategy on one fixture snapshot (the winner differs by strategy as the weights predict), determinism (shuffled input order, same output), explicit constraints, PAYG opt-in, unrated exclusion, unknown penalty, active-participant penalty, reviewer floor fallback, diversity bonus, tie-break by each level.
- Mutation probes on the critical branches: flip the `quotaCost` inversion, drop the cap, change the tie-break order — each has a test that goes red.
