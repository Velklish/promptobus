# PB-329 · A lone test file after a squash runs against the dist/ the last build left

- **Scope:** [Contributing § Worker path](../../guides/contributing.md#worker-path)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** minor

## Evidence

`npm test` builds first (`package.json`, `"pretest": "npm run build"`). A lone `node test/<file>.test.mjs` does not. The tests import `lib/*.js`, and `lib/store.js` loads the compiled `dist/` (`lib/store.js:17–19`). After a change to `src/`, a lone test file therefore runs the new `lib/` against the old `dist/`.

On 2026-10-03 the PB-318 approver squashed the worker branch and ran `node test/teamlead-root-mail.test.mjs` on the squash: exit 1, from a `dist/` built before the squash. After `npm run build`, the same tree gave exit 0, 17/17. Gate briefs ask for exactly such lone runs as evidence for a red, so a stale `dist/` can turn evidence into a false red.

## Work to do

- When `dist/` is older than `src/`, a lone test run fails with a line that names `npm run build`, or the test helper builds first.

## Out of scope

- The `npm test` path, which already builds.

## Verification

- A lone test run after touching a file in `src/` either fails with the named line or passes on a fresh build; a test fails on the old helper.
