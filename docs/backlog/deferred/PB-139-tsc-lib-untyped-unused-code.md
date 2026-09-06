# PB-139 · tsc runs with `include: ["src"]` and no unused-code flags: lib/'s 20,430 lines (30 imports from ../dist across 19 files) are unchecked, and engine.ts:242 already shows the cost (dead `meta` parameter)

- **Scope:** [reference/01](../../reference/01-overview.md) § Entry points, `tsconfig.json`, `src/v1/engine.ts`, `src/migrate.ts`, the 19 `lib/*.js` files listed in Context
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`tsconfig.json:16` is `"include": ["src"]`, and `compilerOptions` (lines 2-15) sets neither `noUnusedLocals` nor `noUnusedParameters`. [reference/01-overview.md](../../reference/01-overview.md) documents the split this reflects: "`src/` is TypeScript... `lib/*.js` is the JS runtime and the three harness drivers" — but nothing there says lib is deliberately left outside `tsc`'s unused-code checking, only that it is a separate runtime.

Measured now: `find src -name '*.ts' | wc -l` → 28 files, `find src -name '*.ts' -exec cat {} \; | wc -l` → 8,381 lines; `find lib -name '*.js' | wc -l` → 43 files, 20,430 lines. `grep -rl '\.\./dist' lib | sort` names 19 distinct files (`lib/done.js`, `drivers.js`, `guard.js`, `harness-home.js`, `host.js`, `install.js`, `liftoff.js`, `model-routing/{catalog,preflight,render,resolver,telemetry}.js`, `models.js`, `review.js`, `server.js`, `spawn.js`, `status.js`, `store.js`, `warden.js`) across 30 `import` occurrences; `grep -rl '@ts-check' lib` returns nothing, so none of the 19 carry even a lightweight type check on their `../dist` imports.

`npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters` reports exactly two errors on the current tree:
```
src/v1/engine.ts(242,33): error TS6133: 'meta' is declared but its value is never read.
src/migrate.ts(35,8): error TS6133: 'process' is declared but its value is never read.
```
`src/v1/engine.ts:242` is `function finish(task: string, meta: TaskV1, sender: ParticipantV1, recipients: ParticipantV1[], ...)`, called at lines 298 and 319 with a `meta` argument that `finish`'s body never reads. `src/migrate.ts:35` is `import process from 'node:process';`, unused in the file. Both are real and both are invisible today because the flags are off.

## Work to do

- Add `"noUnusedLocals": true, "noUnusedParameters": true` to `tsconfig.json`'s `compilerOptions`.
- Delete the unused `meta` parameter from `finish()` in `src/v1/engine.ts:242` and update its two call sites at lines 298 and 319 to drop the argument they pass.
- Delete the unused `import process from 'node:process';` at `src/migrate.ts:35`.
- Add `// @ts-check` as the first line of each of the 19 `lib/*.js` files that import from `../dist` (listed in Context), as a boundary-safety net against a silent break from a `src/` export rename — without committing to full `checkJs` coverage of the rest of `lib/` in this pass.
- Run `npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters` after the edits and confirm zero errors.

## Out of scope

- A full type-check pass over all of `lib/` (a `tsconfig.lib.json` or `checkJs: true` across all 43 files) — the first-pass error count on 20,430 lines of untyped JS is unknown and unbounded, disproportionate as a first step.
- Adding `@ts-check` to `lib/*.js` files that do not import from `../dist` — this pass only covers the boundary files named above.

## Verification

- `npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters` exits 0 with no errors.
- `grep -c '@ts-check' lib/done.js lib/drivers.js lib/guard.js lib/harness-home.js lib/host.js lib/install.js lib/liftoff.js lib/model-routing/catalog.js lib/model-routing/preflight.js lib/model-routing/render.js lib/model-routing/resolver.js lib/model-routing/telemetry.js lib/models.js lib/review.js lib/server.js lib/spawn.js lib/status.js lib/store.js lib/warden.js` shows 1 in each.
- `npm test` stays green (the parameter removal changes no observable behaviour).

## Deferred

- **Deferred:** 2026-09-07
- **Reason:** The recipe does not actually include lib JavaScript in tsc: tsconfig.json includes only src and has no allowJs/checkJs. A project-wide cleanup would overlap nearly every track.
- **Return condition:** After runtime integration, define a separate noEmit JavaScript check project and measure its diagnostics before choosing the migration scope.

## Triage — 2026-09-07

- **Track:** X — Deferred structural work.
- **Priority:** P3.
- **Evidence level:** source/definition review at `1e0401a`, including `src/v1/engine.ts:242`, `src/migrate.ts:35`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Correct the implementation recipe before revival: @ts-check does not make files excluded by tsconfig.json enter tsc. A separate noEmit config with allowJs/checkJs and explicit lib inclusion is needed for a CLI gate. Do not quietly widen the build root or migrate all JavaScript.
