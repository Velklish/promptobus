# PB-30 · Resolver: the balance strategy by pace of the window, role quality floors, reviewer in balance

- **Order:** 80
- **Scope:** `lib/model-routing/resolver.js`, `lib/models.js`, `lib/model-routing/render.js`, `schemas/model-routing/{decision,overlay}.schema.json`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-23, PB-24

## Context

ADR-003's four strategies score by rating with `remaining` at 15 % of the weight. ADR-004 (PB-23) adds `balance`: the strategy that spends the owner's three subscriptions evenly by the pace of their windows, with the reviewer inside the balance and quality floors per role. The snapshot v2 (PB-24) gives the resolver everything it needs: windows with `kind`, `lengthSec`, `resetAt`, `usedPercent` and `scope`, and the tier.

## Work to do

- `STRATEGIES` gains `balance`; `--strategy balance` accepted by `spawn`, `review`, `models`.
- Pace, per ADR-004 decision 2: for a candidate tuple, the applicable windows are the harness's account-wide windows plus the scoped one covering it (Claude: the model-scoped weekly; Cursor: the pool its model falls into); the binding window is the one with the highest `usedPercent`; `elapsedShare = (now − (resetAt − lengthSec)) / lengthSec`, `usedShare = usedPercent / 100`, `underspend = elapsedShare − usedShare`. Candidates on a harness with no known windows are excluded from `balance` with the reason `no-pace` and a warning; when no harness has windows, `balance` falls back to `balanced` scoring and says so.
- Selection: filters 1–6 of ADR-003 unchanged; among survivors the harness with the largest underspend wins (ties within the band the ADR names → the existing tie-break); inside the harness the tuple is chosen by the role's ordering the ADR fixes (quality first, then `quotaCost` against the underspend so a heavy tuple does not eat a small margin). Every candidate appears in the decision with its binding window, `elapsedShare`, `usedShare`, `underspend` and the exclusion reason.
- Quality floors as policy values: `qualityFloor: { worker: 3, reviewer: 5 }` in the overlay schema (replacing the single `reviewerQualityFloor`, which stays readable as an alias); soft fallback with a warning as before.
- Reviewer: the "reviewer stays on Claude Code" assumption is not in the package — confirm nothing in `resolver.js` or the skills pins the reviewer's harness; the diversity bonus stays.
- `models` text: the pace table per harness (window, used, elapsed, underspend) under the candidates; `--json` carries the same numbers.
- `decision.schema.json` extended additively.

## Out of scope

- The near-limit warning and `defaults.strategy` — PB-32.
- Overlay list merging — PB-31.

## Verification

- `npm test`: pace on a fixture snapshot (three harnesses, one scoped window, one pool); exclusion with `no-pace`; the fallback when nothing has windows; floors per role; reviewer chosen on a non-Claude harness when its underspend is largest; the decision carries the numbers.
- Mutation probe after commit: swap `usedShare` and `elapsedShare` in the formula → the ordering test fails.
- `npm run audit`, `backslop lint`.
