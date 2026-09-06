# PB-26.2 · A Fable-scoped window names claude-fable-5, which the inventory does not list and the catalog does not rate

- **Scope:** `lib/driver-claude.js` (`MODEL_IDS`), `models/catalog.json`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-26, PB-29

## Context

**Closed by PB-29 landing (2026-09-06, `main` de6d981): `claude-fable-5` is in `MODEL_IDS` and the catalog rates it, and the exception in the adapter test's guard check was removed with the merge.** What follows is the state that made the entry.

PB-26 asked for two things and delivered one. The Claude adapter now resolves a `weekly_scoped` limit row's display name into ids through `MODEL_SCOPE_IDS` in `lib/driver-claude.js`, so a Fable-scoped window arrives as `scope: { model: "Fable", models: ["claude-fable-5"] }`. The other half — PB-26's "add `fable` → the pinned id the catalog names for it, so a `fable` row is `rated`" — is not done, and deliberately: the constant is `MODEL_IDS`, which belongs to PB-29 (catalog v2).

So today, on this branch:

- `MODEL_IDS` is `['claude-opus-5', 'claude-sonnet-5']` (`lib/driver-claude.js`), and the inventory the adapter reports is those two plus the three aliases and the default model — `fable` appears only as an unrated alias row;
- `models/catalog.json` carries no `claude-fable-5` tuple (`grep -c claude-fable-5 models/catalog.json` → 0 on 2026-09-06);
- the window therefore names an id no tuple carries. ADR-004 describes exactly this state for an unbound scope — the window stays in the snapshot, is printed for a person, and binds nothing — so nothing is broken, but the pace of a Fable row is not read on the harness that meters it.

`test/model-routing-adapter-claude.test.mjs` carries the exception explicitly: the scope-table check allows `claude-fable-5` outside `MODEL_IDS` and asserts that the exception is still needed, so the day PB-29 adds the id that check goes red and whoever lands it deletes the exception.

Related but separate: PB-34 is about the *proven binary* lagging Fable 5.1. This entry is only about the id the driver and the catalog already agree on.

## Work to do

- Once PB-29 has added `claude-fable-5` to `MODEL_IDS` and a rated row to `models/catalog.json`, delete the `PENDING` exception in the scope-table check of `test/model-routing-adapter-claude.test.mjs` and the paragraph in [03-cli](../../reference/03-cli.md) that says the id is not rated yet.
- Check that a Fable-scoped window then really binds: `promptobus models --json` shows the `weekly-fable` window and the `claude-fable-*` candidates carry its `usedPercent` in their `remaining`.

## Out of scope

- Rating Fable 5.1 — PB-34.
- The adapter's own resolution, which is done.

## Verification

- The scope-table check in `test/model-routing-adapter-claude.test.mjs` passes with no exception in it.
- `npm test`, `npm run audit`, `backslop lint` green.
