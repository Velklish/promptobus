# PB-59 · Under balance the floor warning says no candidate reaches the quality floor while a floor-meeting candidate is scored, eligible and representative on another harness

- **Scope:** [ADR-004](../../adr/adr-004-subscription-balance.md) § The balance strategy (the pick, step 1), [ADR-005](../../adr/adr-005-ten-point-scale-absolute-bands-calibrate.md) § Quality floors per role, `lib/model-routing/resolver.js` (`bestOf`, `representatives`, the floor warning), [03-cli](../../reference/03-cli.md) § Model routing
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

promptobus v0.5.0 (ratings on the ten-point scale, `qualityFloor: { worker: 5, reviewer: 9 }` per ADR-005). Current code, verified at these exact lines:

`lib/model-routing/resolver.js:636-640` applies the floor **inside one harness only**, falling back to the harness's own top row when nothing in it reaches the floor:

    const bestOf = (rows_) => {
      if (!rows_.length) return null;
      const above = Number.isFinite(floor) ? rows_.filter((r) => r.quality >= floor) : rows_;
      return above.length ? above[0] : rows_[0];
    };

`lib/model-routing/resolver.js:654-661` builds `representatives` with exactly this rule, one call to `bestOf` per harness, so a harness with nothing above the floor is still represented by a below-floor tuple; `resolver.js:670-693` (the `balance` pick) compares these representatives by `effective` (pace) only, with no re-check of the floor before choosing.

`lib/model-routing/resolver.js:694-700` then raises the warning purely from the chosen row:

    if (Number.isFinite(floor) && chosen && chosen.quality < floor) {
      warnings.push({
        code: role === 'reviewer' ? 'reviewer-floor-not-met' : 'worker-floor-not-met',
        message: `no ${role} candidate reaches the quality floor of ${floor} of 10 — `
          + `"${chosen.tupleId}" was taken as the best remaining one`,
      });
    }

Probe on the repo's own `test/fixtures/model-routing/balance-catalog.json`, role `reviewer` (floor 9), with codex's tuples rated quality 8: `--strategy balance` picks `codex-sol` (effective 12.61, quality 8) and prints `reviewer-floor-not-met: no reviewer candidate reaches the quality floor of 9 of 10 — "codex-sol" was taken as the best remaining one`, while `claude-opus` (quality 10, eligible, `pace.representative: true`, effective 5.48) is standing scored in the same document. The identical catalog under `--strategy balanced` picks `claude-opus` and raises no floor warning — the falsehood is specific to `balance`, because under the other four strategies `chosen = bestOf(scored)` is taken over the whole candidate list rather than over one representative per harness.

The message contradicts the shipped documentation on both sides: ADR-004 § Quality floors per role (docs/adr/adr-004-subscription-balance.md:149-155) and docs/reference/03-cli.md:155 both define the warning as firing "when nothing reaches the floor", full stop. The two docs also disagree with each other about the pick itself — ADR-004's own "The pick, in order" step 1 (line ~137, `Among eligible candidates, each harness is represented by its best tuple by the role's ordering; the harness's effective is that tuple's.`) says nothing about the floor, while 03-cli.md's parallel restatement (line 612) already reads `... represented by its best tuple by the role's ordering that meets the role's quality floor` — a rule the code at 636-640/654-661 does not actually enforce, since `bestOf` falls back to a below-floor row rather than excluding the harness.

`node --test test/model-routing-resolver.test.mjs` passes 85/85 — no fixture in the suite exercises two harnesses where one representative meets the floor and the other does not.

## Work to do

- Stop the warning from stating a falsehood: raise `reviewer-floor-not-met` / `worker-floor-not-met` with today's wording only when no scored candidate anywhere meets the floor. When some scored candidate does meet it and the pick still doesn't, print a different message naming both tuples — the one taken, its harness, and the floor-meeting tuple standing on the other harness — so a reader sees why the floor was passed over instead of being told it was unreachable.
- Owner's call: decide whether `balance` may take a harness whose representative is below the floor while another harness's representative meets it. If not, build the tied set of representatives from floor-meeting ones only, whenever any exists — the same rule `bestOf` already applies inside a harness, lifted one level up to `representatives`; this is consistent with ADR-004 A2 (the floor is a choice rule over the scoring, not a filter, so raising it above the harness comparison keeps the same shape).
- Whichever way (b) goes, reconcile the two step-1 texts: state the chosen rule in ADR-004 § The balance strategy (the pick, step 1), which today omits the floor entirely, and align docs/reference/03-cli.md § Model routing (line ~612) so both documents describe the same behaviour the code implements.
- Add a golden fixture in test/fixtures/model-routing/ with two harnesses — the better-paced one carrying only below-floor tuples, the other carrying a floor-meeting tuple — and assert in test/model-routing-resolver.test.mjs that the printed warning (or the pick, per (b)) matches the decision actually made.

## Out of scope

- The union/intersection rules for overlay merging that PB-30 and PB-31 already settled — unrelated to this warning.
- PB-43's fix (representing a harness by its best-paced pool rather than its best-scored tuple) — orthogonal: this entry is about the floor's interaction with the harness-representative comparison, not about which pool inside one harness is chosen.

## Verification

- New fixture plus assertion in test/model-routing-resolver.test.mjs covering the two-harnesses-one-below-floor arrangement; `npm test` green.
- Manual: `promptobus models --strategy balance --role reviewer` against the fixture prints the corrected warning text (or makes the corrected pick, depending on which half of (b) is chosen).
