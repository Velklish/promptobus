# PB-24 · Snapshot schema v2: generalised windows with kind, scope and pools, the harness tier, hidden models

- **Scope:** `schemas/model-routing/snapshot.schema.json`, `lib/model-routing/{cache,preflight,render,validate}.js`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-23
- **Taken:** 2026-09-06

## Context

The v1 snapshot (`schemas/model-routing/snapshot.schema.json`) knows a harness as `{ state, reason, message, checkedAt, source, resetAt, version, models[], windows[] }` with a window `{ id, usedPercent, lengthSec, resetAt }` and a model `{ model, rated, flags }`. That is the Codex shape. ADR-004 (PB-23) decision 1 needs the same record to carry Claude's model-scoped weekly window, Cursor's two monthly pools with the model families each covers, and the tier of every harness.

## Work to do

- Extend the schema, additively: a window gains `kind` (`session` | `weekly` | `monthly`) and `scope` (`null`, `{ model }`, or `{ pool: "auto" | "api", models: [...] }`); a harness gains `tier: { name, source } | null` and, for Codex, `credits` / `resetCredits` as informational fields; a model gains `hidden: boolean`. Old cache files (schemaVersion 1) are read and migrated in memory or discarded with `stale_cache` — choose per ADR-004 and say which in the reference.
- `cache.js`: TTL for limit data stays 60 s; the tier follows the auth TTL (1 h). The cache still holds no token, email or account id — the tier name is not an identifier.
- `render.js` / `models` text and `--json`: per harness, one line per window with kind, scope, used percent, reset time; the tier on the harness line.
- `validate.js`: the new fields validated; a window with `kind: monthly` needs `lengthSec` from the cycle; a scoped window needs its scope.
- Reference: the snapshot section names every field and the migration rule.

## Out of scope

- Reading the new fields from the harnesses — PB-26, PB-27, PB-28.
- Using them in scoring — PB-30.

## Verification

- `npm test`: schema fixtures for a v1 snapshot and a v2 snapshot; a scoped window without scope refused; `models --json` on a fixture cache prints every window.
- `npm run audit`, `backslop lint` green.
