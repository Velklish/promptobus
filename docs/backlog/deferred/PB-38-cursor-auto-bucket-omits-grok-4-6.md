# PB-38 · Cursor's autoBucketModels names grok-4.5 and not cursor-grok-4.6, so the 4.6 tuples are paced against the api pool while Cursor's own nudge calls Grok 4.6 a Cursor model

- **Scope:** `lib/model-routing/adapter-cursor.js`, `models/catalog.json`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Live acceptance run of the adapters on 2026-09-06 (`models --refresh` against `main` 73f24f7): the Cursor `monthly-auto` window's scope carried `models: [composer-2.5, composer-2.5-fast]` only — the payload's `autoBucketModels` lists composer, vega, `grok-4.5` and `cursor-grok-4.5-*`, not `cursor-grok-4.6-*`, so by the adapter's rule (exact id or `name + "-"`) every `cursor-grok-4.6` tuple maps to the `api` pool (98.4 % used) and is paced there. Yet the same account's `GetUsageLimitStatusAndActiveGrants` nudge says "Switch to Grok 4.6" as the Cursor-model alternative when the third-party pool runs short, i.e. Cursor bills Grok 4.6 to the Auto pool. Either the bucket list lags Cursor's own billing, or the 4.6 ids are billed differently from the 4.5 ones; the adapter cannot tell from the payload. Consequence today: under `balance` the grok-4.6 rows look exhausted with the api pool and are never picked, while the owner's spend data (PB-29 evidence: grok-4.6 xhigh fast 101 240 cents this cycle) says they are the account's most used models.

## Work to do

- Measure: one turn on `cursor-grok-4.6-medium` and re-read `GetCurrentPeriodUsage` — which percentage moved, `autoPercentUsed` or `apiPercentUsed`.
- If auto: treat the family prefix `cursor-grok-` as the Auto pool regardless of the bucket list version (a documented exception with the measurement as evidence), or read the pool from `GetAggregatedUsageEvents.tier` (2 = auto) per model when the bucket list is silent.
- If api: nothing to change in the adapter; the reference names the nudge as marketing, not billing.

## Out of scope

- The catalog's Cursor rows themselves.

## Verification

- A fixture with a bucket list that omits a family the nudge names; `models --refresh` on the owner's machine shows the grok-4.6 tuples paced against the measured pool.

## Deferred

- **Deferred:** 2026-09-06
- **Reason:** needs one live measured turn on the owner's Cursor account to know which pool bills grok-4.6; the adapter follows the payload's own bucket list until then, which is the conservative reading (the api pool is the fuller one).
- **Return condition:** the `v0.4.0` tag is cut and the owner runs one turn on a `cursor-grok-4.6-*` model; then this returns to the queue with the measurement.
