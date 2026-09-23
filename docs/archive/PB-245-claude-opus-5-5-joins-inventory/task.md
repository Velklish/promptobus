# PB-245 · Claude Opus 5.5 joins the Claude inventory and the catalog

- **Order:** 560
- **Scope:** [03-cli](../../reference/03-cli.md), [guides/model-routing](../../guides/model-routing.md), `lib/driver-claude.js`, `models/catalog.json`
- **Created:** 2026-09-23
- **Dependencies:** none

## Context

The owner updated `claude` from 2.1.263 to 2.1.280 on 2026-09-23 and asked for every participant to run on Opus 5.5. The lift refuses it before any session starts:

```
✖ --model claude-opus-5-5: no tuple of the merged catalog names it (rated models: claude-fable-5, claude-fable-5-1, claude-haiku-4-5, claude-opus-5, claude-sonnet-5, …)
```

An overlay cannot add a tuple, so the model has to enter the shipped catalog and the driver's inventory. The 2.1.280 baked table, read offline, holds `claude-opus-5-5` as a first-party row of `family:"opus"` (`display_name` "Opus 5.5", `fallback_3p:"claude-opus-5"`, `pricing:"tier_4_20_cache_read_0_20"`), lists it beside `claude-opus-5` among the accepted ids, and points the `opus` alias at it; `alias_migration` is `{}`.

## Work to do

- `MODEL_IDS` carries `claude-opus-5-5` beside `claude-opus-5`; the `opus` limit scope names both ids.
- The catalog gains the Opus 5.5 ladder — `xhigh` base, `max`, `high` and `medium` interpolated — with each rating cited or named a hypothesis, and the Claude priority block renumbered in steps of ten.
- The counts the suite and the docs pin (rated tuples, reviewer and approver rows, base models with a `quality` hypothesis) follow the new rows.

## Out of scope

- Re-proving the driver on 2.1.280 and moving `MODEL_ALIAS_IDS.opus` — one lift and one message, filed separately.
- The GPT-6 models the installed Codex CLI now lists — they depend on re-measuring the Codex protocol fixtures.

## Verification

- `npx github:Velklish/backslop#v0.9.0 gates` and `promptobus models validate` on the working tree.
- `promptobus spawn --dry-run --harness claude --model claude-opus-5-5` no longer refuses.
- A mutation probe: `claude-opus-5-5` dropped from `MODEL_IDS` turns the adapter test and the catalog test red.
