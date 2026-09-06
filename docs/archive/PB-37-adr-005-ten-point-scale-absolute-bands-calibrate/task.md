# PB-37 · ADR-005: ratings on a 1–10 scale with absolute bands per benchmark and version, and models calibrate proposing overlay corrections from local telemetry

- **Scope:** [ADR-003](../../adr/adr-003-model-routing.md), [ADR-004](../../adr/adr-004-subscription-balance.md), `models/catalog.json`, `schemas/model-routing/*.json`, `lib/model-routing/{resolver,validate,catalog}.js`, new `lib/model-routing/calibrate.js`, `lib/models.js`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06, owner's decision 2026-09-06
- **Dependencies:** the 0.4.0 tag; PB-36 (telemetry records exist); the catalog track's finding on the rule defects of ADR-004 § Catalog ratings (filed under PB-29, lands with it)
- **Taken:** 2026-09-06

## Context

Three things the 0.4.0 series learned about ratings, all recorded in the catalog track's finding under PB-29 and in the PB-29 review: a rank band over a narrow field does not discriminate at the top (Opus 5 at 96.0 and Fable 5 at 95.0 share band 5 of 5; the other natural rank cut would have split them the wrong way); benchmark figures are not identified by benchmark and version alone — the agent harness is part of the figure; and a 1–5 scale leaves five steps for a field that the owner wants to see ranked more sharply. The owner's decision (2026-09-06): a **1–10 scale**, **absolute bands per benchmark and version** fixed in the ADR and revisited at each catalog update, and **local statistics** (PB-36) read back on request to propose corrections — not applied silently.

## Work to do

- **ADR-005**: the scale 1–10 for `quality`, `speed`, `quotaCost`; the normalisation `(r − 1) / 9` in every strategy's components; the role floors restated on the new scale (owner to confirm the numbers: today's worker ≥ 3 / reviewer ≥ 5 map to ≥ 5 / ≥ 9, or the owner chooses others); absolute bands per benchmark and version (e.g. SWE-bench Verified: ≥ 95 → 10, ≥ 92 → 9, …) with the rule that a figure without its agent harness is not a figure; interpolation across effort levels restated; what the migration of overlay `ratings` written on 1–5 does (refuse with a message, or scale ×2 − 1 and warn — decide).
- **Catalog v3**: the 45 rows re-banded by the absolute rule; `schemaVersion` of the catalog bumped; validate refuses 1–5 values.
- **`models calibrate`**: reads `telemetry.jsonl`, aggregates per tuple (runs, median duration, review rounds per accepted piece, window delta per run), compares with the catalog's `speed` and `quotaCost` and, where the evidence is strong enough (a threshold the ADR fixes, e.g. ≥ 5 runs), **prints proposed `ratings` lines for the user overlay with the numbers behind each** — the person adds them; the tool never writes ratings itself. `quality` from telemetry is indirect (review rounds, findings) and is proposed only as a note in v1.
- Reference and skills: when to run `calibrate`, how to read its proposal, how the overlay line looks.

## Out of scope

- Automatic application of calibrated ratings; telemetry beyond what PB-36 records; any upload.

## Verification

- `npm test` on a telemetry fixture of a few dozen records: the aggregation, the threshold, the proposal text; the catalog v3 validates; strategies' components sum as before on the new scale.

## Deferred

- **Deferred:** 2026-09-06
- **Reason:** the owner's decision — 0.4.0 ships the balance strategy and the telemetry collection first, so the data starts accumulating; the scale and the reading of the data are the next series, not a change to a contract accepted mid-run.
- **Return condition:** the `v0.4.0` tag is cut; then this returns to the head of the queue as the first task of the next series.
