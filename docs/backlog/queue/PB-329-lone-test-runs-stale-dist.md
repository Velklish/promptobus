# PB-329 · A lone test file after a squash runs against the dist/ the last build left

- **Order:** 600
- **Scope:** [Contributing § Worker path](../../guides/contributing.md#worker-path)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** minor

## Evidence

`npm test` builds first (`package.json`, `"pretest": "npm run build"`). A lone `node test/<file>.test.mjs` does not. The tests import `lib/*.js`, and `lib/store.js` loads the compiled `dist/` (`lib/store.js:17–19`). After a change to `src/`, a lone test file therefore runs the new `lib/` against the old `dist/`.

On 2026-10-03 the PB-318 approver squashed the worker branch and ran `node test/teamlead-root-mail.test.mjs` on the squash: exit 1, from a `dist/` built before the squash. After `npm run build`, the same tree gave exit 0, 17/17. Gate briefs ask for exactly such lone runs as evidence for a red, so a stale `dist/` can turn evidence into a false red.

## Original work to do

- When `dist/` is older than `src/`, a lone test run fails with a line that names `npm run build`, or the test helper builds first.

## Original out of scope

- The `npm test` path, which already builds.

## Original verification

- A lone test run after touching a file in `src/` either fails with the named line or passes on a fresh build; a test fails on the old helper.

## Context

Promote the original Cost: minor finding to contributor-readiness work. npm test and test:local build first; direct node test/<file> does not prove freshness. The TS migration now has two build source sets and generated runtime lib/*.js as well as dist. The historical stale-dist false red after squash remains evidence of why direct-test results need source provenance, separate from PB-432 coverage selection.

## Work to do

- Choose the smallest shared direct-test freshness guard or build-first direct-test helper that fits existing test entrypoints; document the supported invocation and failure message naming npm run build.
- Cover sources consumed by both tsconfig.json and tsconfig.runtime.json, their generated outputs and checkout/squash/SHA transitions; do not rely only on src/mtime.
- Wire the chosen mechanism into the supported direct-test path without changing the already build-first npm test behavior.
- Add a stale-generated-output fixture that demonstrates the old direct-test path can use previous-build output and the selected path refuses or rebuilds it.

## Acceptance criteria

- A supported lone test after changing either build source set cannot silently run stale generated code: it builds first or fails clearly naming npm run build.
- Fresh builds and checkout/source transitions are handled deterministically; a regression fails with the old helper and verifies the relevant generated runtime and dist outputs.
- Contributor guidance distinguishes direct-test readiness from test coverage selection, and preserves the existing npm test contract.

## Out of scope

- PB-432 coverage policy, changing the already build-first npm test path, a repository-wide build-system redesign or a freshness check that covers only src.

## Verification

- Retain the exact stale/fresh fixture commands, source/build provenance, exits and diagnostic; include a representative direct test plus both build source-set controls.
- Run npm run build, the focused freshness/helper fixture, relevant documentation checks and configured gates after changes. Proposed checks are notRun; historical 17/17 after build is not current validation.

## Next step

Execute the bounded investigation in queue order; retain the original evidence and hypothesis label and satisfy the stated execution prerequisites before implementation or live work.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
