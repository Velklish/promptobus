# PB-104.1 · ADR-004 says a person asking `models` sees the withheld hidden rows and the exclusion detail says "hidden"; the shipped resolver and renderer filter them out and name the account instead — the owner decides which side moves

- **Order:** 120
- **Scope:** [ADR-004](../../adr/adr-004-subscription-balance.md), `lib/model-routing/resolver.js`, `lib/model-routing/render.js`, [03-cli](../../reference/03-cli.md) § Model routing
- **Created:** 2026-09-10
- **Dependencies:** PB-104

## Context

PB-104 aligned the CLI reference with what the code does: a row the harness lists and declines to offer is kept in the availability snapshot with `hidden: true` (ADR-004, PB-28), while the resolver's inventory, the `runtime` list and everything `models` prints are the rows without the mark; `models validate` never read hiding at all. Measured by `worker:docs` on the balance fixture for every strategy: `runtime` is `[]` for the hidden row, the hidden text never appears, and the rated-row detail reads "the codex account does not expose <model>" rather than "hidden".

ADR-004's stated intent is the other reading: a person sees the whole inventory including the withheld rows, and the exclusion detail of a rated tuple names the hiding. PB-104 was scoped to the documentation and left this fork open on purpose; a decision either amends the ADR to the shipped behaviour or changes `render.js` and `resolver.js` so that the withheld rows are shown to a person and the detail says "hidden".

## Work to do

- Owner's decision of 2026-09-10: keep the shipped behaviour. Amend ADR-004's intent sentence by clean replacement, dated: a hidden row is carried in the availability snapshot so the cache matches what the harness lists; the resolver's inventory and the `runtime` list are the rows without the mark; `models` prints those projections; the exclusion detail names the account.
- The doc comment at `lib/model-routing/resolver.js:133-143` still promises that "a person asking `models` sees" the withheld row — bring it to the same story. 03-cli § Model routing already tells it (PB-104); check that "Hidden rows are not inventory" still agrees.
- Keep the snapshot fidelity half (hidden rows retained on disk) as PB-28 built it.

## Out of scope

- Any change to what a harness marks hidden — that is the adapter's reading of the harness, unchanged.

## Verification

- ADR-004, 03-cli § Model routing, the resolver comment and the resolver/render output agree on one story; the existing model-routing tests stay green; no runtime change.

## Triage — 2026-09-10

- **Track:** R — Routing policy, overlays and availability (documentation only).
- **Priority:** P2.
- **Evidence level:** `lib/model-routing/resolver.js:133-146` and `:417`, `docs/adr/adr-004-subscription-balance.md:101`, `docs/reference/03-cli.md:236`, `:496` and `:616` at `3ccdf27`.
- **Decision (owner, 2026-09-10):** amend the ADR; no resolver or render change. One `Changed` CHANGELOG line.
- **Next step:** implement as decided.
