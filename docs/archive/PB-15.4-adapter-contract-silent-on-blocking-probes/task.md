# PB-15.4 · The adapter contract permits a probe that defeats the preflight budget

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none

## Context

`AvailabilityAdapter.probe` may return `Promise<ProbeVerdict> | ProbeVerdict` (`src/model-routing.ts`), and `timeoutMs` is documented as "the adapter's own ceiling … the whole preflight budget: adapters run in parallel, so each may use all of it".

Both sentences are true and, together, they do not hold. The budget is enforced by `runProbes` in `lib/model-routing/preflight.js` as a `setTimeout` racing `Promise.all(started)`. A probe that blocks the event loop — the natural shape, since `lib/exec.js` `run()` is `spawnSync` and every driver already reaches for it — stops that timer from firing while it runs. The adapters then do not run in parallel at all: they run one after another, each may consume the whole budget, and the ceiling of a routed command becomes the SUM of its adapters rather than the one budget ADR-003 fixes at 15 s and the reference repeats twice.

The synchronous return is not the problem — an adapter that already knows its answer should return it. The problem is that nothing says a probe must not hold the loop, so the first author to write the obvious thing gets a run whose ceiling is three times what was promised, and nothing goes red: every check still passes, the budget check included, because it measures one adapter.

PB-15 hit this in review and its adapter now spawns asynchronously with a deadline of its own (`lib/model-routing/adapter-claude.js`); the Cursor track files the sibling about `resolveToolBin`, which is synchronous inside the host and can spend seconds on a cold binary — that one is the same failure through a call the adapter does not own.

## Work to do

Pick one and write it down in both places (`src/model-routing.ts` doc comment and [03-cli](../../reference/03-cli.md) § Availability):

- **Say it.** "`probe` must not block the event loop; a synchronous return is for an answer already in hand. An adapter that runs a process spawns it asynchronously and kills it on its own deadline." Cheapest, and it puts the rule where an adapter author reads it.
- **Or hand an absolute deadline** instead of a duration — `deadlineAt` beside or in place of `timeoutMs` — so a late-started adapter cannot restart the clock, and say that the preflight's own timer is advisory.

Consider a gate for it: the preflight suite can schedule a timer beside a deliberately blocking stub adapter and assert it still fires, which is the check PB-15's own suite now carries for its adapter.

## Out of scope

- `resolveToolBin` being synchronous — the Cursor track's sibling finding.
- The 15 s number itself, which ADR-003 fixed.

## Verification

- An adapter written as `spawnSync` fails the stated rule visibly — by a gate, or by a sentence an author can be pointed at in review.
- With a blocking stub in the preflight suite, the run's wall clock stays at one budget rather than growing with the number of harnesses.
