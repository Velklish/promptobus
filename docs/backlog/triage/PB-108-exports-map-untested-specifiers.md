# PB-108 · No test resolves the package's declared entry points via their npm specifiers — the exports map is asserted for key-presence only, so a broken mapping ships green

- **Scope:** [01-overview](../../reference/01-overview.md), `test/promptobus-package.test.mjs`, `package.json`, `lib/host.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

test/promptobus-package.test.mjs:371 checks only that the exports map has the right keys: `Boolean(pkg.exports?.['./host']) && Boolean(pkg.exports?.['./hooks'])`. The tarball-install probe later in the same file (lines 394-411) imports exactly one entry point, hardcoded: `path.join(installedPkg, 'dist', 'index.js')` via pathToFileURL, never a bare specifier. `grep -rn "from '../dist/" lib/` returns 25 hits across four distinct dist targets (../dist/index.js, ../dist/host.js, ../dist/host-index.js, ../dist/hooks.js); lib/host.js:4,10 import ../dist/host.js specifically, which is NOT itself a key in package.json's exports map — only ./host → ./dist/host-index.js is. `grep -rn "from 'promptobus" test/ scripts/` returns exactly one hit, and it is a comment (test/host.test.mjs:89), confirming no test in the package resolves any of its own public specifiers (promptobus, promptobus/host, promptobus/hooks, promptobus/driver, promptobus/cli, promptobus/schemas/*) the way a consumer actually would, through Node's exports-map resolution.

Downstream, ati-agents does depend on exactly the specifier form this package never tests: cli/lib/promptobus/host.js:4 and :9 `import ... from 'promptobus/host'`, cli/lib/sync.js:18 `import { planPromptobusHooks } from 'promptobus/hooks'` (both confirmed present in the ati-agents checkout). So a broken or mis-pointed exports entry — e.g. a future rename of dist/host-index.js without updating package.json, or accidentally aliasing ./host to the wrong dist file — would pass npm test and npm pack --dry-run (the two commands .github/workflows/ci.yml runs) and only fail downstream, inside the consumer's own build.

docs/reference/01-overview.md § Entry points (lines 7-20) already names the same six surfaces from the source side (src/index.ts → '.', src/host-index.ts → './host', src/hooks.ts → './hooks', src/driver.ts → './driver', lib/cli.js → './cli', schemas/v1/*.json → './schemas/*'), so it is the natural place a reader checks the intended mapping against.

## Work to do

- Extend the existing tarball-install block in test/promptobus-package.test.mjs (same scaffolding already built at lines 380-411 — installed tarball, installedPkg path) to loop over the six declared specifiers — promptobus, promptobus/driver, promptobus/host, promptobus/hooks, promptobus/cli, and one concrete schema path promptobus/schemas/v1/task.schema.json — resolving each with Node's own module resolution rooted at the installed tree (e.g. spawn `node --input-type=module` with cwd set to the install target, or import.meta.resolve from a module inside it) rather than a hand-built file path.
- Assert one known export or successful resolution from each: PACKAGE_NAME/PROTOCOL_VERSION from '.', a driver factory from './driver', isPromptobusHost from './host', a hook-planner export from './hooks', that './cli' resolves at all (it carries no types field to check against), and that the schema file parses as JSON.

## Out of scope

- Adding new exports-map entries or changing which specifiers are public — this entry only tests the ones already declared.
- Type-level resolution checking (.d.ts correctness) — PB-11.2 is the adjacent, already-filed entry for a related but distinct gap in the exported type re-exports.

## Verification

- node --test test/promptobus-package.test.mjs passes with the new specifier-resolution loop added (currently 20/20 pass with the single-entry probe).
- A deliberate mutation probe: rename the ./dist/host-index.js export inside package.json's exports.['./host'].default to a non-existent path — the new loop fails; the existing key-presence check at line 371 does not.
