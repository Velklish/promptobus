# PB-31 · Overlay merge: deny and allow lists by union, selectors by role and by model flag

- **Order:** 90
- **Scope:** `lib/model-routing/catalog.js`, `lib/model-routing/validate.js`, `schemas/model-routing/overlay.schema.json`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-23

## Context

ADR-003 merges overlay lists by replacement per selector kind: a higher layer's `deny.tuples` replaces a lower one's. The first consumer measured the cost (a finding in its own tracker): to make its policy bans hold it had to sit on top of the person's workspace file and erase the person's own `deny.tuples`; rules by role ("the reviewer never runs here") and by model flag (`no-zdr` in the Cursor inventory) could not be written at all. ADR-004 decision 5 changes the merge to union and adds the two selectors.

## Work to do

- **Union**: `deny` lists of every kind accumulate across layers; a ban written in any layer stands. `allow` per the ADR's answer (intersection, or most-specific-wins) — implement exactly the recorded answer. `models validate` reports a tuple denied by every path and an `allow` no tuple satisfies, naming the layer each rule came from.
- **Selector by role**: an overlay may scope a rule to `worker` or `reviewer` (the ADR fixes the shape — for example `roles: { reviewer: { deny: { harnesses: ["cursor"] } } }`); the resolver applies role rules only when routing that role; `validate` refuses an unknown role.
- **Selector by model flag**: `deny: { flags: ["no-zdr"] }` excludes every tuple whose model carries the flag in the snapshot inventory; a flag the snapshot never sets is a warning, not an error.
- Schema additive: a v1 overlay stays valid; the reference names the new keys and the merge rule with an example of two layers.
- The decision output names, per excluded candidate, the layer and the rule that excluded it (today it names the layer only).

## Out of scope

- The consumer's own layer order — the host chooses (ADR-003, "Host contract").
- Sealing a layer against higher ones: not needed under union; if the ADR keeps the idea for `allow`, implement what it says.

## Verification

- `npm test`: two layers with different `deny.tuples` → both bans hold; a role rule excludes for the reviewer and not for the worker; a flag rule excludes the flagged model; `validate` names layer and rule; a v1 overlay fixture still loads.
- Mutation probe after commit: make the merge replace again → the "both bans hold" test fails.
- `npm run audit`, `backslop lint`.
