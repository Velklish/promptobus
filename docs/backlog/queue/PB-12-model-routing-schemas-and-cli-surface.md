# PB-12 · Model routing schemas, CLI surface, error codes, and golden tests before the resolver

- **Order:** 20
- **Scope:** [03-cli](../../reference/03-cli.md), [04-protocol](../../reference/04-protocol.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-11

## Context

Stage 1 of the routing plan: contracts are fixed and tested before any resolver logic exists, so later tasks (catalog, adapters, resolver, flags) implement against golden fixtures instead of inventing shapes. The `models --json` output is promised to be stable from its first version; that promise is only real if a fixture pins it now.

## Work to do

- JSON schemas under `schemas/model-routing/`: `catalog.schema.json`, `overlay.schema.json`, `snapshot.schema.json` (cache file), `decision.schema.json` (the `models --json` output). The decision schema carries at least: strategy and role, chosen tuple, total score and its components, availability state of every considered candidate, exclusion reasons and warnings, data source and snapshot age, whether an overlay and explicit constraints applied.
- CLI surface written into [03-cli](../../reference/03-cli.md) before implementation: `promptobus models [--strategy <quality|balanced|speed|economy>] [--role <worker|reviewer>] [--refresh] [--json]`, `promptobus models validate`, `promptobus models --clear-exhausted <harness>`, `spawn`/`review` gain `--strategy <…>` and `--allow-payg`; `--dry-run` runs live probes, prints the decision, writes neither cache nor task state. Error and reason codes listed once, in the reference.
- Golden tests: fixture files for the decision JSON and for `models` text output, compared byte-for-byte; a test that argv without the new flags takes exactly the current path (`lib/spawn.js` `liftHarness` / `resolveEffort`, lines 296–316) — the legacy behaviour test the plan asks for.
- Contract quotes in `--help` where the existing suite pins help text.

## Out of scope

- Catalog content, probes, cache, scoring — PB-13 … PB-18.
- Implementing the commands: this task lands schemas, docs and red-or-skipped golden tests that later tasks turn green.

## Verification

- `npm test`, `npm run audit`, `backslop lint` green; schema files validate their own examples.
- Mutation probe: change a field name in the decision fixture, the golden test goes red.
