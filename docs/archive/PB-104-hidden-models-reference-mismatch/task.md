# PB-104 · The CLI reference says `models` shows hidden inventory rows and that `models validate` can call a row hidden; the code does neither, and the same file states the opposite at line 585

- **Order:** 770
- **Scope:** [03-cli](../../reference/03-cli.md), `lib/model-routing/resolver.js`, `lib/models.js`, `lib/model-routing/render.js`, `lib/model-routing/validate.js`
- **Created:** 2026-09-06
- **Dependencies:** PB-43

## Context

docs/reference/03-cli.md:216 says of the `models` field in the availability snapshot: "A row the harness lists and declines to offer is carried with `hidden: true` (ADR-004): a person asking `models` sees the whole inventory, and the resolver's inventory is the rows without it." docs/reference/03-cli.md:465 repeats the claim and adds one about `models validate`: dropping hidden rows used to cost "the other half — `promptobus models` showed an inventory that did not match what the harness itself lists, and `models validate` could only call a hidden row *missing* where the honest answer is that it is hidden." docs/reference/03-cli.md:585 says the opposite of both: "a hidden unrated row is not a `runtime` row either: it is not something a person could pick" — hidden rows do NOT reach what `models` prints.

The code matches line 585, not 216/465. `inventoryOf` (lib/model-routing/resolver.js:137-138) is the only place a hidden row is read out of the snapshot, and it drops it: `return Array.isArray(entry.models) ? entry.models.filter((m) => m.hidden !== true) : null;`. `runtimeRows` (resolver.js:498-508), the only source of the unrated-row listing, builds off `inventoryOf`, so a hidden unrated row never reaches it either. `availabilityOf` in lib/models.js — the projection `models` prints from — carries `harness/state/reason/checkedAt/source/tier/spendControlReached/credits/resetCredits/windows` and no model list at all, so there is no "whole inventory" for a person to see through this command in the first place. `lib/model-routing/render.js` has no occurrence of `hidden`. `lib/model-routing/validate.js` imports only `node:fs`, `../drivers.js`, `./cache.js` and `./catalog.js` — it reads no availability snapshot, so `models validate` cannot say "missing" or "hidden" about a model row at all; its own comment near line 533 hands that question to the resolver ("Whether any model of a RUN carries one is a question only a run can answer, and the resolver answers it").

Probed on HEAD (cc1aca8) with the shipped balance fixtures — test/fixtures/model-routing/balance-snapshot.json carries a hidden rated Codex row `gpt-5.6-preview` and a hidden unrated row `gpt-5.6-internal` (lines 56-57) — resolving a decision from it under every strategy yields `runtime: []` and no occurrence of `gpt-5.6-internal` anywhere in the decision; the only trace of the hidden rated row is the exclusion detail on the tuple naming it, `the codex account does not expose "gpt-5.6-preview"` (resolver.js:409-411) — "missing", never "hidden".

ADR-004 states the same thing as an intent ("a person asking `models` should see...") that line 216 restates as settled fact — so the ADR and the code are also not aligned, though which side should move is an ADR-owner decision, not something this entry settles.

## Work to do

- Rewrite docs/reference/03-cli.md:216 to say a hidden row is kept in the availability snapshot on disk (so the cache matches what the harness lists) while the resolver's inventory, the `runtime` list, and everything `models` prints are the rows with the mark filtered out.
- Rewrite line 465's `models validate` clause to drop the claim that hiding was ever partly fixed for that command — `models validate` never read model hiding either before or after PB-28, so there is nothing to say there beyond the snapshot-fidelity half.
- Leave line 585 as written — it is the sentence that already matches the code.
- Record the ADR-004 fork as an open question for the owner rather than resolving it here: if the ADR's stated intent (a person seeing the withheld rows, and the exclusion detail saying 'hidden') is what should ship, that is a `render.js`/`resolver.js` behavior change and belongs in its own follow-up entry.

## Out of scope

- Changing render.js or resolver.js so `models` actually surfaces hidden rows to a person, or so the exclusion detail says "hidden" instead of "does not expose" — that code-side fork needs an owner decision first.
- Re-litigating whether hiding a row from `runtime` and from a tuple's candidacy is correct — PB-28 already settled that; only the prose describing it is wrong.

## Verification

- docs/reference/03-cli.md lines 216 and 465 no longer claim `models`/`models validate` surface a hidden row; line 585 unchanged.
- node --test test/model-routing-resolver.test.mjs stays green (85 passing) — no code changes in this entry.
- Re-run the balance-fixture probe used to verify this entry (`runtime: []`, no `gpt-5.6-internal`, no `hidden` string, "does not expose" detail for the hidden rated row) and confirm the corrected prose describes exactly that output.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/model-routing/resolver.js:137`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Correct the reference to current behavior. A change to which hidden inventory rows the product displays remains an ADR/product decision, not a documentation fix.
