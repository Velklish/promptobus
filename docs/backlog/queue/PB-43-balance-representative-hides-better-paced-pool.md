# PB-43 · Under balance a harness is represented by its best-scored tuple, so Cursor's Auto pool never enters the pace comparison while a third-party tuple wins the score

- **Order:** 15
- **Scope:** [ADR-004](../../adr/adr-004-subscription-balance.md) § The balance strategy (the pick, step 1), `lib/model-routing/resolver.js` (the pace layer), [03-cli](../../reference/03-cli.md) § Model routing
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Measured 2026-09-06 12:40 UTC on the owner's account (promptobus 0.5.0, `models --refresh --strategy balance --role worker`), the pace block:

```text
cursor  cursor-gemini-37-high · monthly-api  · 98.4% used · 45.2% elapsed · underspend -53.17
codex   codex-luna-max        · primary      · 66.0% used · 80.2% elapsed · underspend +14.20
claude  claude-opus-xhigh     · weekly       · 83.0% used · 57.0% elapsed · underspend -26.04
```

ADR-004 says "each harness is represented by its best tuple by the role's ordering; the harness's effective is that tuple's". Cursor's best tuple by the `balanced` score is `cursor-gemini-37-high` (speed 10, quotaCost 1), and its binding window is the **api** pool. Cursor's **Auto** pool — the one holding the harness's own models (composer, grok-4.6 since PB-38) — stood at 86.1 % used at 45.2 % elapsed, underspend −41: still behind Claude and Codex on this day, but 12 points better than the pool Cursor was judged by, and never compared at all. Whenever a third-party row outscores every Cursor-own row, the Auto pool is invisible to the pace layer — and the api pool is nearly always the fuller one on this plan, so Cursor is never picked while it has room in the pool the owner pays for first.

## Work to do

- Represent a harness in the pace comparison by its best **eligible and best-paced** binding window, not by the best-scored tuple's window: for a harness with several pools, each pool (its best tuple) enters step 1 as its own candidate, and the band and the tie inside it work as today. State it in ADR-004 § The balance strategy as a clarification, or in an ADR-006 if the shape of the decision output changes (the pace block would carry one row per pool).
- `models` prints one pace row per pool for Cursor so a person sees both.
- Golden fixture with a harness whose best-scored tuple sits in a spent pool while a lower-scored tuple's pool has room: the pick goes to the pool with room.

## Out of scope

- Whether the Auto pool should be preferred over the api pool by policy — that is pace, and pace already says it.

## Verification

- The fixture above; `npm test`; live `models --refresh --strategy balance --role worker` on the owner's account shows a Cursor pace row for `monthly-auto`.
