# PB-30 · Resolver: the balance strategy by pace of the window, role quality floors, reviewer in balance

- **Scope:** `lib/model-routing/resolver.js`, `lib/models.js`, `lib/model-routing/render.js`, `schemas/model-routing/{decision,overlay}.schema.json`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-23, PB-24
- **Taken:** 2026-09-06

## Context

ADR-003's four strategies score by rating with `remaining` at 15 % of the weight. ADR-004 (PB-23) adds `balance`: the strategy that spends the owner's three subscriptions evenly by the pace of their windows, with the reviewer inside the balance and quality floors per role. The snapshot v2 (PB-24) gives the resolver everything it needs: windows with `kind`, `lengthSec`, `resetAt`, `usedPercent` and `scope`, and the tier.

## Work to do

- `STRATEGIES` gains `balance`; `--strategy balance` accepted by `spawn`, `review`, `models`.
- Pace, per ADR-004 decision 2: for a candidate tuple, the applicable windows are the harness's account-wide windows plus the scoped one covering it (Claude: the model-scoped weekly; Cursor: the pool its model falls into); the binding window is the one with the highest `usedPercent`; `elapsedShare = (now − (resetAt − lengthSec)) / lengthSec` (clamped 0…1), `usedShare = usedPercent / 100`, `underspend = (elapsedShare − usedShare) × 100` — **percentage points of the window**, the one unit of the pace layer (ADR-004); `band`, `spendUnit` and `nearLimit.underspend` are in the same points. `balance` is a choice layer over the `balanced` scoring, not a filter (ADR-004): every surviving candidate keeps its place and score and gains a pace block — `window`, `usedShare`, `elapsedShare`, `underspend`, `spendPenalty = balance.spendUnit × (quotaCost − 1) / 4`, `effective = underspend − spendPenalty`, `eligible` with the note `no-pace` | `window-spent`; a window whose `resetAt` is absent or not in the future is not paced. No eligible candidate → the best `balanced` score with the warning `balance-fallback`.
- Selection: filters 1–6 of ADR-003 unchanged; each harness is represented by its best tuple by the merged `balanced` weights (the role's ordering); the largest `effective` leads; harnesses within `balance.band` (default 5 points; `balance.spendUnit` defaults to the band) of the leader are tied and the `balanced` score of the representatives decides, then ADR-003's tie-break. Every candidate appears in the decision with its pace block.
- Quality floors as policy values: `qualityFloor: { worker: 3, reviewer: 5 }` in the overlay schema (`reviewerQualityFloor` stays readable as an alias; a layer stating both is a `validate` warning, the explicit key wins); choice rules, soft fallback with `reviewer-floor-not-met` and the new `worker-floor-not-met`.
- Reviewer: the "reviewer stays on Claude Code" assumption is not in the package — confirm nothing in `resolver.js` or the skills pins the reviewer's harness; the diversity bonus stays.
- `models` text: the pace table per harness (window, used, elapsed, underspend, penalty, effective) under the candidates; `--json` carries the same numbers.
- `remaining` becomes per tuple for every strategy: the applicable windows are the account-wide ones plus the scope covering the tuple (ADR-004, "Every strategy gains from the scoped windows"); golden fixtures move with the snapshot version.
- `decision.schema.json`: `schemaVersion` → 2 (`DECISION_SCHEMA_VERSION` in `resolver.js`), the fifth `strategy` value, `candidates[].pace`, the two warning codes and `strategySource`; golden fixtures move with it (ADR-004: the bump belongs to this task; the top-level `harnesses` block of PB-24 is optional and already on `main`).

## Out of scope

- The near-limit warning and `defaults.strategy` — PB-32.
- Overlay list merging — PB-31.

## Verification

- `npm test`: pace on a fixture snapshot (three harnesses, one scoped window, one pool); exclusion with `no-pace`; the fallback when nothing has windows; floors per role; reviewer chosen on a non-Claude harness when its underspend is largest; the decision carries the numbers.
- Mutation probe after commit: swap `usedShare` and `elapsedShare` in the formula → the ordering test fails.
- `npm run audit`, `backslop lint`.
