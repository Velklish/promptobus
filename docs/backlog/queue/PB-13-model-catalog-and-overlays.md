# PB-13 · Model catalog with rated tuples, overlay merge, and models validate

- **Order:** 30
- **Scope:** [03-cli](../../reference/03-cli.md), [02-host](../../reference/02-host.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-12

## Context

Stage 2 of the routing plan. The catalog is the maintainers' rating of real tuples; it ships with the package (`files` in `package.json`) and is updated event-driven when the model line-up or prices change. Overlays let a person or a consumer change weights, ratings, allow/deny rules and PAYG policy without forking the catalog.

Effort dictionaries already live in the drivers: `lib/driver-claude.js` line 81, `lib/driver-cursor.js` line 146, `lib/driver-codex.js` line 41 (`EFFORT_LEVELS`), and each driver names its `defaultModel`. Cursor carries effort as a suffix of the model id, not a flag (`lib/driver-cursor.js` around line 140) — a Cursor tuple's `model` is the full id, and the resolver must not add `--effort` for it.

## Work to do

- `models/catalog.json` with the first matrix: every model the three harnesses expose to the owner's accounts as measured live (Claude model list, `agent models`, Codex `model/list`), each with 1–5 `quality`, `speed`, `quotaCost`, allowed roles, billing mode, nullable prices, canonical priority, `assessedAt`, source and evidence. A model without a maintainer rating gets no catalog entry — it appears only as a runtime `unrated` row (PB-14 snapshot). Do not invent ratings; a rating without a source is a hypothesis and stays out.
- Loader: `canonical → global overlay → workspace overlay → CLI constraints`; paths from the host (PB-11 methods). Overlay may change weights, penalties, bonuses, reviewer floor, allow/deny of harnesses, models and efforts, ratings, canonical priority, PAYG policy. Missing overlay files are normal, not an error.
- `promptobus models validate`: schema, references to tuple/model/harness, rating ranges, weight sums, duplicate ids, contradictory allow/deny; catalog efforts checked against the driver's `EFFORT_LEVELS`.
- Stale `assessedAt` produces a warning, never an exclusion.
- Example overlay in docs (a deny rule, a weight change, a PAYG opt-in) — the file a person copies.

## Out of scope

- Probes, cache, resolver — PB-14, PB-18.
- Automatic ratings from telemetry.

## Verification

- Tests: merge precedence (each layer overrides the previous one field by field), validate catches each listed defect, stale warning, unrated exclusion from auto-selection data.
- Mutation probe on the merge: swap the layer order, the precedence test goes red.
- `npm run audit` green — the catalog carries model ids only, no account or forge names.
