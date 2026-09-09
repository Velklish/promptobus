# PB-155 · `mergeFlat` and `mergeWeights` are the two overlay-merge helpers in catalog.js without the `__proto__` guard PB-32 added to their two siblings, so an overlay can move the merged policy's prototype on the routed lift, which never runs `validate`

- **Scope:** `lib/model-routing/catalog.js` (`mergeFlat`, `mergeWeights`, `mergeDefaults`, `mergeAccount`, `applyOverlayToPolicy`), `test/model-routing-catalog.test.mjs`, [reference/03-cli](../../reference/03-cli.md) § Catalog and overlays
- **Created:** 2026-09-06
- **Dependencies:** none
- **Taken:** 2026-09-09

## Context

catalog.js has four overlay-merge helpers for the routing policy, and only two of them guard against a JSON-parsed `__proto__` key reaching a plain-assignment loop. `mergeWeights` (catalog.js:282-290) and `mergeFlat` (catalog.js:292-297) both do `out[name] = ...`/`out[k] = v` with no check; `mergeDefaults` (catalog.js:329-338) and `mergeAccount` (catalog.js:346-363) both skip the key explicitly — `if (key === '__proto__') continue;` at line 333, and the same check at lines 353 and 356 — with a comment at catalog.js:318-327 spelling out why: a plain assignment to the key `__proto__` reaches the prototype setter rather than creating an own property, and a policy whose prototype had moved would then be routed on a document that `validate` — which refuses that key as unknown — never got to see, because the routed lift runs the merge without a validate pass.

Both unguarded helpers back live overlay fields: `mergeFlat` merges `penalties`, `bonuses`, `qualityFloor`, `balance` and `nearLimit` (`applyOverlayToPolicy`, catalog.js:426-430) plus `payg` (catalog.js:440), and `mergeWeights` merges `weights` (catalog.js:425) — seven blocks total, all populated straight from `JSON.parse` of a file a person or an overlay wrote. A live probe against the real `mergeRouting` export with an overlay `{"bonuses":{"__proto__":{"totallyNewField":"x"}}}` confirms the exposure: `Object.getPrototypeOf(merged.policy.bonuses) !== Object.prototype` afterward, and `merged.policy.bonuses.totallyNewField` reads through the moved prototype as a non-own property. No value changes today, because every field `DEFAULT_POLICY` names on these seven blocks is an own-property default that shadows the moved prototype on every current read — the exposure is the first new key an overlay's `__proto__` object names, or any future policy field whose default is `undefined`.

This is the one gap review closed for `mergeDefaults` and `mergeAccount` in PB-32's fix commit (`73f24f7`, 2026-09-06, the same day as current HEAD `cc1aca8`) but not for their two neighbours in the same file. `grep -rln "__proto__" test/` finds no test file at all — neither the fixed pair nor the unfixed pair has a regression test today. The closest existing test (`test/model-routing-catalog.test.mjs:1114`, 'a tuple whose id is a prototype key…') covers a different mechanism, `applyOverlayToTuples`'s `Object.hasOwn` guard over tuple ids, not the policy-block merges.

## Work to do

- Add `if (k === '__proto__') continue;` inside `mergeFlat`'s loop (catalog.js:292-297), before the assignment.
- Add `if (name === '__proto__') continue;` inside `mergeWeights`'s loop (catalog.js:282-290), before both the assignment and the `note(name)` call.
- Add a parity test in `test/model-routing-catalog.test.mjs` asserting `Object.getPrototypeOf(...)` stays `Object.prototype` after an overlay carrying a `__proto__` key, for each of the seven affected blocks (`weights`, `penalties`, `bonuses`, `qualityFloor`, `balance`, `nearLimit`, `payg`) — the coverage PB-32 added for `mergeDefaults`/`mergeAccount` and, per the grep above, apparently did not add even there.

## Out of scope

- Making `loadCatalog` run `validate` on the routed lift path — that is the larger, deliberate design point the `mergeDefaults` comment names (catalog.js:326-327), and a much bigger change than this parity fix.
- `applyOverlayToTuples`'s own `__proto__` handling (catalog.js:501+, `Object.hasOwn`) — already guarded, unaffected by this fix.

## Verification

- The probe overlay above (`{"bonuses":{"__proto__":{"totallyNewField":"x"}}}`) run through `mergeRouting`: `Object.getPrototypeOf(merged.policy.bonuses) === Object.prototype` and `merged.policy.bonuses.totallyNewField === undefined`.
- `npm test` green with the new parity cases added.

## Triage — 2026-09-07

- **Track:** R — Routing policy, overlays and availability.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `test/model-routing-catalog.test.mjs:1114`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
