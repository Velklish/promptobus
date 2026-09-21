# PB-242 · The Codex app-server fixtures name their protocol version in a literal path, and nothing notices when the installed binary moves past it

- **Order:** 470
- **Area:** [Drivers](../../reference/05-drivers.md), `test/harness-codex.mjs`, `lib/driver-codex.js`
- **Created:** 2026-09-22
- **Depends on:** none

## Context

The schemas the Codex harness validates against were generated from one binary and stored under
`test/fixtures/codex-app-server/0.146.0/`. The same number lives twice more: as
`PROVEN_CODEX_VERSION` in `lib/driver-codex.js:37`, which the lift refusal and the driver report
quote, and as the literal directory name in `test/harness-codex.mjs:22`.

Two failures follow from the copy, and neither announces itself.

**The constant moves and the fixture path does not.** Bump `PROVEN_CODEX_VERSION` to a version
whose schemas were regenerated into a new directory and the harness keeps validating against the
old one: every test stays green while it asserts a protocol nobody ships any more.

**The installed binary moves and both stay put.** A protocol fixture is a citation of somebody
else's code, and a citation is worth its version tag. When the local `codex` is newer than the
fixtures, the suite is green about a protocol the machine no longer speaks — the quietest form
of a stale citation, because nothing in the repository knows the binary exists.

## What to do

- Read the fixture directory off `PROVEN_CODEX_VERSION` in `test/harness-codex.mjs` instead of
  the literal, so the two cannot disagree.
- Add a test that the directory named by the constant exists and carries the schema files the
  harness compiles. A bumped constant without regenerated fixtures then fails loudly.
- Add `scripts/check-codex-schema.mjs` plus an npm script: compare `codex --version` with
  `PROVEN_CODEX_VERSION` and report the regeneration command on a mismatch. No binary on the
  machine means nothing to compare — say so and exit 0, because CI has no `codex`.

## Not in scope

- Regenerating the schemas for a newer binary: the installed one is `codex-cli 0.146.0`
  (measured 2026-09-22), the same version the fixtures carry.
- Putting the new script in CI. It reads a binary that CI does not install; it belongs to the
  local gates, beside `npm run probe`.

## Checks

- `npm test` — green, with the fixture-presence verdict in it.
- Mutation probe: set the constant to a version with no fixture directory → the new test fails
  and names the missing path; restore → green.
- `node scripts/check-codex-schema.mjs; echo $?` — 0 on this machine (binary and constant agree);
  with `PATH` stripped of `codex`, still 0 and says the binary is absent.
