# PB-60 · An unreadable or unsupported overlay silently drops the recorded strategy default from every lift, and nothing is printed

- **Order:** 220
- **Scope:** `lib/models.js` (`effectiveStrategy`, `routeLift`), `lib/spawn.js`, `lib/review.js`, `lib/model-routing/catalog.js` (the `schemaVersion` gates), [03-cli](../../reference/03-cli.md) § Commands
- **Created:** 2026-09-06
- **Dependencies:** PB-78

## Context

Current code, promptobus v0.5.0, HEAD cc1aca8. `lib/models.js:491-505` (`effectiveStrategy`):

    export function effectiveStrategy(host, { strategy, catalogFile = CATALOG_FILE, now = Date.now() } = {}) {
      if (strategy !== undefined && strategy !== null) return { strategy, source: 'flag' };
      let merged;
      try {
        merged = loadCatalog({ host, catalogFile, now });
      } catch (e) {
        // A broken layer is not this function's refusal to make. Returning `null`
        // takes the legacy path, and the very next thing a routed call does is load
        // the same stack through `mergedCatalog`, which raises the layer-named
        // refusal a person can act on. [...]
        if (e instanceof GateError) return null;
        throw e;
      }
      ...
    }

The comment's justification cannot hold on any path: line 492 returns before the `try` whenever `--strategy` is given, so the `catch` fires only on a call with **no flag** — and that exact call is the one that returns `null` and stops, never reaching `routingContext`/`mergedCatalog` to raise the promised layer-named refusal. `lib/models.js:398-399` (`routeLift`): `const effective = effectiveStrategy(host, {...}); if (!effective) return null;`. `lib/spawn.js:632` calls `routeLift`; when it returns `null`, `lib/spawn.js:653` falls to `liftHarness(host, routed?.harness ?? opts.harness)` — the pre-routing path, with no warning printed anywhere on this branch. `lib/review.js:520` reaches the same `null` through `effectiveStrategy` directly.

Probe (standalone host, diverted HOME, `user` overlay `{schemaVersion:2, defaults:{strategy:"balance"}}`) confirmed three independent triggers, all silent:
- a writable `workspace` overlay holding malformed JSON;
- a `user` overlay still on `schemaVersion: 1` carrying a scaled rating key (`lib/model-routing/catalog.js:593-599` throws `GateError` for this);
- a `user` overlay with an unsupported `schemaVersion` (`catalog.js:601-603` throws `GateError`).

In all three, `effectiveStrategy(host, {})` returns `null`, `routeLift(host, {role:'worker'})` returns `null`, and nothing reaches `console.warn`/`console.error`; on the same stack, `promptobus models strategy` refuses outright, naming the file. The second and third triggers are the exact shape of the ADR-005 migration: after v0.5.0 shipped ratings on the ten-point scale, a person's untouched pre-upgrade overlay silently un-routes every `spawn` and `review`, with `spawn`/`review` running on pre-routing defaults and no `strategySource` recorded in `metadata.routing`.

This contradicts docs/reference/03-cli.md:76 — "the same precedence a lift uses, so `models` and the next `spawn` cannot disagree about what is in force" — because on this exact stack they do disagree: `models` refuses, `spawn` proceeds unrouted and silent.

No test names `effectiveStrategy`, and no lift test in the suite (model-routing-command.test.mjs, promptobus-spawn.test.mjs) feeds a broken overlay to a lift.

## Work to do

- Separate "no default is recorded" from "the stack could not be read" at lib/models.js:494-505. Minimal fix: keep returning `null` on a read failure, but emit one `warn()` on the way out naming the layer and its path plus the command to see the whole picture (`promptobus models validate`), so an unrouted lift is visibly unrouted instead of silent.
- Owner's call for a stronger fix: return a distinct signal (e.g. `{ unreadable: err }`) instead of `null`, and have `routeLift` raise it through `mergedCatalog`'s existing layer-naming refusal — so a workspace with a recorded default refuses the lift rather than quietly demoting it, matching "two gates, both before any write to disk".
- Remove or rewrite the comment at lib/models.js:497-502 — the routed call it defers to never runs on the branch where the comment sits.
- Add a test that lifts under a recorded strategy default plus (a) a malformed overlay and (b) a `schemaVersion: 1` overlay carrying a scaled rating key, asserting the run is not silent per whichever fix is chosen.
- Update docs/reference/03-cli.md next to the sentence at line 76 to describe the corrected behaviour.

## Out of scope

- The existing refusal behaviour of `models strategy` / `models validate` on a broken overlay — that already works and is not touched.
- Any read failure elsewhere in the routing stack outside `effectiveStrategy`'s own swallow.

## Verification

- New test: a lift under a recorded default plus a broken overlay produces a non-silent outcome (a warning in output, or a raised `GateError`, per the chosen fix); `npm test` green.
- Manual: on a workspace with a malformed writable overlay, `promptobus spawn` shows the new warning (or refuses), and `promptobus models strategy` on the same stack still refuses naming the file — the two commands now agree.

## Triage — 2026-09-07

- **Track:** R — Routing policy, overlays and availability.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/models.js:491`, `lib/spawn.js:632`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Queue the observable diagnostic for an unreadable default, using the smallest behavior described in the task. A change from warning/fallback to fail-closed routing requires a separate approved contract decision; do not infer that approval from this triage.
