# PB-124 · MODEL_FLAGS is the only one of eight closed routing vocabularies pinned against its schema twin by a test, so the other seven can drift silently

- **Scope:** [reference/03-cli](../../reference/03-cli.md) § Model routing (Reason codes, Exclusion/adjustment/warning codes), `lib/model-routing/cache.js`, `lib/model-routing/catalog.js`, `lib/model-routing/validate.js`, `lib/model-routing/resolver.js`, `schemas/model-routing/snapshot.schema.json`, `schemas/model-routing/overlay.schema.json`, `schemas/model-routing/decision.schema.json`, `schemas/model-routing/telemetry.schema.json`, `test/model-routing-catalog.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** PB-43, PB-105
- **Taken:** 2026-09-09

## Context

Re-verified against current HEAD (v0.5.0). Eight closed vocabularies each exist once in code and once (or twice) in a schema, and the code copy is the source of truth nowhere the suite checks:

- `MODEL_FLAGS` (`cache.js:204`) ↔ `overlay.schema.json` `$defs.flagList.items.enum` and `snapshot.schema.json` `$defs.model.properties.flags.items.enum` — the ONE pair with a test: `test/model-routing-catalog.test.mjs:696-697` does `assert.deepEqual(overlaySchema.$defs.flagList.items.enum, MODEL_FLAGS)` and the same against the snapshot schema.
- `WINDOW_KINDS` (`cache.js:236`, `['session','weekly','monthly']`) ↔ `snapshot.schema.json:174` `window.properties.kind.enum` and `telemetry.schema.json:110` — byte-identical, no test.
- `TIER_SOURCES` (`cache.js:330`, `['credentials','probe','derived','user']`) ↔ `snapshot.schema.json:124` `tier.properties.source.enum` — no test.
- `TIER_NAME_RE` (`cache.js:342`, `/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/`) ↔ `snapshot.schema.json:120` `tier.properties.name.pattern` — identical string, no test.
- `STRATEGIES` (`catalog.js:151`) ↔ `overlay.schema.json:118` `defaults.strategy.enum` and `decision.schema.json:13` `strategy.enum` — no test.
- `SELECTOR_KINDS` (`catalog.js:167`, `['harnesses','models','efforts','tuples','flags']`) ↔ `overlay.schema.json` `$defs.selectors` (line 194) and `$defs.roleSelectors` (line 217) property names — no test.
- `WEIGHT_KEYS` (`validate.js:39`, `['quality','speed','quotaCost','remaining']`) ↔ `overlay.schema.json:176` `$defs.weightSet.required` — no test.
- `DECISION_WARNINGS` (`resolver.js:71-74`, 9 codes) ↔ `decision.schema.json:341-350` `$defs.warningCode.enum` (same 9, different order) — no test.

`grep -rn "WINDOW_KINDS|TIER_SOURCES|STRATEGIES|SELECTOR_KINDS|WEIGHT_KEYS|DECISION_WARNINGS" test/*.mjs` returns nothing. `test/model-routing.test.mjs:257-273` (the docs↔schema table-parity test) checks the code TABLES in `docs/reference/03-cli.md` against the schema enums, not against these code constants, so it does not substitute.

A ninth case has no exported list to pin at all: exclusion codes are written inline across three functions in `resolver.js` — `policyExclusion` (`:299`, `:304`, `denied-by-policy`), `constraintExclusion` (`:382`, `constraint-mismatch`), and `exclusionOf` itself (`:400` `role-not-allowed`, `:409` `model-not-in-inventory`, `:419` `harness-unavailable`, `:425` `harness-exhausted`, `:432` `payg-not-allowed`) — seven codes in total, matching `decision.schema.json:321-330` `$defs.exclusionCode.enum` exactly today, held by nobody.

Not already tracked: grepped `docs/backlog` and `docs/archive` for these constant names and for "parity"/"drift"; the closest neighbours — PB-15.2, PB-20.2, PB-21.1 — are about other pairs (prose-vs-code wording, a version line, a missing raiser), not this set of unpinned constants. Not deliberate: no ADR or `result.md` explains why only `MODEL_FLAGS` got the check.

## Work to do

- Extend `test/model-routing-catalog.test.mjs` with one `assert.deepEqual` per pair, next to the existing `MODEL_FLAGS` assertions: `WINDOW_KINDS` vs `snapshot.schema.json` and `telemetry.schema.json`'s `kind.enum`; `TIER_SOURCES` vs `snapshot.schema.json`'s `tier.source.enum`; `TIER_NAME_RE.source` vs `tier.name.pattern`; `STRATEGIES` vs `overlay.schema.json`'s `defaults.strategy.enum` and `decision.schema.json`'s `strategy.enum`; `SELECTOR_KINDS` vs `overlay.schema.json`'s `$defs.selectors`/`$defs.roleSelectors` property names; `WEIGHT_KEYS` vs `overlay.schema.json`'s `$defs.weightSet.required`.
- Add the same `deepEqual` (sorted, since declaration order need not match) for `DECISION_WARNINGS` against `decision.schema.json`'s `$defs.warningCode.enum`.
- Export a named `EXCLUSION_CODES` list from `resolver.js` gathering the seven strings currently scattered across `policyExclusion`, `constraintExclusion` and `exclusionOf`, and pin it against `decision.schema.json`'s `$defs.exclusionCode.enum` the same way.
- No CHANGELOG entry: all nine pairs already agree, so this is a test-only change with no behaviour difference.

## Out of scope

- Changing any of the nine values themselves — every pair agrees today; this only gates future drift.
- The docs↔schema table-parity test (`test/model-routing.test.mjs:257-273`) — it checks a different pairing (prose tables vs schema) and needs no change.

## Verification

- `node --test test/model-routing-catalog.test.mjs` passes with the nine new assertions added.
- Temporarily add a value to `WINDOW_KINDS` (or any other pinned constant) without touching its schema twin — the extended test fails, then revert.

## Triage — 2026-09-07

- **Track:** R — Routing policy, overlays and availability.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `test/model-routing-catalog.test.mjs:696`, `test/model-routing.test.mjs:257`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** The schema-to-reference code tables are already compared in test/model-routing.test.mjs:257. This task covers remaining implementation-to-schema parity; do not describe every routing vocabulary as entirely ungated or duplicate the existing checks.
