# PB-406 · Model routing decides on current, plan-aware subscription limits

- **Scope:** [03. CLI § Model routing](../../reference/03-cli.md#model-routing)
- **Created:** 2026-10-28
- **Dependencies:** none
- **Cost:** major
- **Taken:** 2026-10-28

## Context

The owner observed on 2026-10-27/28 that routing decisions in a consumer workspace's run rested on stale or plan-blind data, and decided on 2026-10-28 to fix it in five pieces in the same run. Evidence (package 0.30.0, the same code as this tree for the routing modules): `promptobus spawn` and `review` printed `snapshot-stale`, `unknown-remaining` and `balance-fallback`; without an explicit `--model` the `balance` strategy once picked a Cursor gemini model charged to the third-party `api` pool while the included `auto` pool was at 17.6 % (`promptobus models --refresh --json`, 2026-10-27); a cap of two concurrent Codex participants measured on a smaller plan had to be lifted by the owner by hand.

The routing code scores `usedPercent` only and compares percentages across harnesses as equal (`lib/model-routing/resolver.js` pace and `balance`); the tier each adapter reads is "an input to no score" (03-cli § Availability).

## Work to do

- PB-406.1 — windows stay current and an expired probe keeps its last windows with their age.
- PB-406.2 — a Cursor model's cost follows its pool, and the owner can keep routing out of the `api` pool.
- PB-406.3 — the subscription plan and an owner-declared capacity enter the score; per-harness live caps live in the overlay.
- PB-406.4 — a Codex window's kind follows its duration.
- PB-406.5 — OpenCode gets a quota source and catalog tuples.

## Out of scope

- Rewriting the catalog ratings themselves.

## Verification

- Each child card is accepted; this card closes when they are.
