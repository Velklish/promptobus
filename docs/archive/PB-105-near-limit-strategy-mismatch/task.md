# PB-105 · The near-limit signal decides `economy` from the level test alone while raising the line on either test, so under the default `--strategy balance` it prints nothing when every account is ahead of pace

- **Scope:** [03-cli](../../reference/03-cli.md), [ADR-004](../../adr/adr-004-subscription-balance.md), `lib/model-routing/resolver.js`, `skills/orchestrate/SKILL.md`
- **Created:** 2026-09-06
- **Dependencies:** PB-59
- **Taken:** 2026-09-09

## Context

lib/model-routing/resolver.js:784-796 computes the near-limit warning in two passes over the same paced harnesses:

```
const paced = representatives.map((row) => ({ harness: row.harness, row }));
const over = paced.filter(({ row }) => row.pace.usedShare * 100 >= nearLimit.usedPercent);
const short = paced.filter(({ row }) => row.pace.usedShare * 100 >= nearLimit.usedPercent
  || row.pace.underspend < nearLimit.underspend);
if (short.length) {
  const proposed = paced.length && over.length === paced.length ? 'economy' : 'balance';
  if (proposed !== strategy) {
```

`short` (the set a line is raised for) is the union of the level test (`usedShare` past `nearLimit.usedPercent`, default 80) and the rate test (`underspend` below `nearLimit.underspend`, default -15). `over` (the set that decides whether to propose `economy`) is the level test alone. When every paced harness is short only by rate — ahead of its own pace but still under 80% used — `short.length` equals `paced.length` while `over.length` is 0, so `proposed` is `balance`; under `--strategy balance` (the workspace default), line 795 then suppresses the whole block because the proposal equals the strategy already running.

Probed on HEAD (cc1aca8) with the shipped test/fixtures/model-routing/balance-{catalog,snapshot}.json, raising every window's usedPercent so each harness is 16.5-37.5 points ahead of its own pace and none reaches 80% (claude "7d-fable" 78% used/40.5% elapsed, underspend -37.52; codex "secondary" 79%/62.5%, underspend -16.50; cursor "cycle-auto" 70%/47.9%, underspend -22.08): `--strategy balanced`, `quality` and `economy` each print three near-limit lines proposing `balance`; `--strategy balance` prints ZERO lines. node --test test/model-routing-resolver.test.mjs stays green (85 passing) with no fixture covering this case — the one existing "no line when the proposal matches the running strategy" test uses a single short harness, where silence is correct.

skills/orchestrate/SKILL.md:83 already publishes the other reading as the contract an orchestrating agent reads: "`economy` when every paced account is short, `balance` when at least one has room" — "short" there is exactly the union test the resolver code calls `short`. The resolver's own comment (lines 789-792, "at least one other harness has room") is false for the all-short-by-rate case reproduced above. docs/adr/adr-004-subscription-balance.md around lines 218-222 names both thresholds one sentence before saying "past the threshold", so it does not resolve which reading is meant; the code's own warning text also calls the rate bound "the threshold" ("past the -15 the threshold allows"), so the ambiguity is not confined to the ADR.

## Work to do

- Put the fork to the owner: either (a) decide `economy` from the same set the line is raised on — `short.length === paced.length` instead of `over.length === paced.length` — so an account set with nothing having room proposes spending less per run everywhere (the reading skills/orchestrate/SKILL.md:83 already publishes); or (b) keep the level-only rule and give the rate-only-everywhere case its own sentence under `balance` (spend is ahead of pace everywhere, the strategy cannot move it, here is the reset date), because today it produces no output at all.
- Whichever is chosen, make docs/adr/adr-004-subscription-balance.md § The near-limit signal say explicitly which threshold "past the threshold" means, and align skills/orchestrate/SKILL.md:83 and the near-limit row of docs/reference/03-cli.md with the decision.
- Fix the resolver comment at lines 789-792 ("at least one other harness has room"), which is false for a set short only by rate.
- Add a fixture and a test: every paced harness short by the rate test only, none at the level threshold — under --strategy balance the run prints what the chosen reading specifies, not nothing.

## Out of scope

- Changing nearLimit.usedPercent or nearLimit.underspend defaults, or the two-test design itself — this entry is about which test decides the proposed strategy, not about the thresholds.
- Deciding, on this entry's own authority, whether "ahead of pace but with most of the window unspent" deserves an economy proposal — that is exactly the fork put to the owner above.

## Verification

- node --test test/model-routing-resolver.test.mjs — the new fixture's case prints the line the chosen reading specifies under --strategy balance, and the existing 85 tests stay green (checked by hand: at usedPercent 50 only one harness is short, so short.length !== paced.length and balance is unaffected by option (a); at 25 every harness is over, so option (a) still yields economy).
- skills/orchestrate/SKILL.md:83 and the ADR sentence agree with each other and with the code's actual predicate.

## Triage — 2026-09-07

- **Track:** R — Routing policy, overlays and availability.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/model-routing/resolver.js:784`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Queue an accurate visible ahead-of-pace message while retaining current strategy selection. Automatically proposing economy from a different predicate is a policy decision for the owner; keep that branch out of the default fix.
