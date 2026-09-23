# PB-246 · GPT-6 Astra, Sol and Luna are in the installed Codex inventory and in no catalog row

- **Order:** 570
- **Scope:** [guides/model-routing](../../guides/model-routing.md), `models/catalog.json`
- **Created:** 2026-09-23
- **Dependencies:** none; PB-196 owns the protocol fixtures and stays deferred

## Context

The owner asked for the new Codex models in the catalog. `codex debug models` on the installed `codex-cli 0.156.1` (2026-09-23, default home) lists three new rows with `visibility: list`:

- `gpt-6-astra` — "Frontier intelligence for the most demanding work.", efforts `low` … `ultra`;
- `gpt-6-sol` — "Workhorse model for coding and everyday work.", efforts `low` … `ultra`;
- `gpt-6-luna` — "Fast and affordable model for easier tasks.", efforts `low` … `max`.

The same listing now calls `gpt-5.6-sol` "Older coding model for complex work.". No catalog row names a GPT-6 id, so the resolver cannot route to any of them, and an explicit model is refused before launch — `spawn --harness codex --model gpt-6-sol --dry-run`, exit 1:

```
✖ --model gpt-6-sol: no tuple of the merged catalog names it (rated models: claude-fable-5, …)
```

An overlay cannot add a tuple, so the rows have to ship in the catalog.

The Codex adapter reads the inventory from the binary at probe time, so the rows route on 0.156.1 without new protocol fixtures. The fixtures are PB-196's: `npm run codex-schema` is red on this machine because the installed binary is newer than the fixtures (0.156.1 against 0.146.0), and that red is the same on the base commit.

## Work to do

- Rate each model by the guide's procedure — a published figure with its benchmark version and agent harness, or a stated hypothesis placed against the neighbours; the successor rule applies to Sol and Luna against their GPT-5.6 predecessors. Astra has no predecessor in the catalog.
- Add the ladders the inventory offers and the role floors allow; keep the Codex priority block canonical.
- Re-check the inventory of the participant's own `CODEX_HOME`, not only the default home: the guide records that inventory as home-specific.
- Update every count the suite and the docs pin (rated tuples, reviewer rows, base models with a hypothesis).

## Out of scope

- Re-measuring the protocol fixtures and moving `PROVEN_CODEX_VERSION` — PB-196.
- Removing `gpt-5.6-*` rows: the binary still lists them.

## Verification

- Gates, `promptobus models validate`, and `promptobus models --role worker` naming a GPT-6 tuple as a candidate.
