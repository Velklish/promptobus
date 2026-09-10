# PB-63.1 · migrationNeeded() answers true for a sweep-only plan, so a consumer that prints "migration pending" from it says so with no data to move

- **Order:** 40
- **Scope:** `src/migrate.ts` (`migrationNeeded`, `preflight`), [02-host](../../reference/02-host.md) § `legacyLayout()`
- **Created:** 2026-09-09
- **Dependencies:** PB-63

## Context

Finding of the PB-132 review (isolated reviewer, run `pb-run-0909-t20260909-132344`), from the source. Since PB-63 `preflight()` reports `needed: true, sweep: true` when only the transient `migrating.json` mark remains and the former directory is gone; `migrate()` then removes the mark and returns an empty report. `migrationNeeded(root, layout)` (`src/migrate.ts`, "Whether migration is needed at all") returns `preflight().needed` and therefore answers `true` for that state, although nothing will be moved. Inside the package the predicate is called only by tests (`test/boundary.test.mjs`); it is exported from `src/index.ts`, and the consumer CLI does not call it (checked 2026-09-09 in the consumer's `cli/` tree: no `migrationNeeded` caller). A consumer that used it for a "migration pending" line would print it for a mark sweep.

## Work to do

- Decide the predicate's meaning: either `migrationNeeded` answers `needed && !sweep` (a data move is pending) and the doc comment says so, or the comment says explicitly that a mark sweep counts and points callers at `preflight().sweep` to tell them apart.
- A test for the chosen meaning on the dead-mark fixture PB-63 added.
- One sentence in 02-host.md § `legacyLayout()` beside the sweep rule.

## Out of scope

- The sweep itself (PB-63) and the `ensureStore` door — unchanged.

## Verification

- The test above is red on the current tree for the chosen meaning and green after.

## Triage — 2026-09-10

- **Track:** S — Store integrity and public engine.
- **Priority:** P2.
- **Evidence level:** source review at `3ccdf27`: `src/migrate.ts:332-335` — `migrationNeeded` returns `preflight().needed`; `src/index.ts:65` exports it; `test/boundary.test.mjs:185-220` is its only caller inside the package.
- **Decision:** the predicate keeps its answer. A sweep-only plan still needs `migrate()` to remove the dead mark, and PB-63's result already reads the predicate as "call `migrate` before access" — which a sweep satisfies. The doc comment says so and points a caller who must tell a data move from a sweep at `preflight().sweep`; one sentence in 02-host § `legacyLayout()` beside the sweep rule; a test on the dead-mark fixture asserting that `migrationNeeded` is `true` while `preflight().sweep` is `true`. One `Changed` CHANGELOG line: the documented meaning of an exported predicate is pinned.
- **Next step:** implement as decided.
