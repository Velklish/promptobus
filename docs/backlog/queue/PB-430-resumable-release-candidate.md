# PB-430 · Prepare and resume one consistent release candidate

- **Order:** 420
- **Scope:** [Package and release contract](../../reference/01-overview.md), [Releasing](../../guides/releasing.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** major

## Context

The release procedure edits the version, changelog, overview and pinned links by
hand, then asks for gates before committing those edits. The package test also
checks an exact tag on HEAD when one exists. Editing a new version while HEAD
still names the previous release can therefore fail before a candidate exists.

Evidence: on `fe2d59e89e7dbe8061a14432a0d671771cf687d2`, see
`docs/guides/releasing.md`, the link-update command in
`docs/reference/01-overview.md`, and `test/promptobus-package.test.mjs:750-773`.
The retained 0.32.8 gate receipt `pb-release-gates.stdout` for `63b0f4cf`
records `npm test` exit 1 after 306083 ms: 267/269 files, gates 0/5 and four
not run. The failures were the installation-link contract and overview version.
Each named test failed twice separately; both passed on base `b588a80c`.
After the metadata correction, release `2d36f6e1` passed all five gates.
These are historical observations from the 2026-11-13 release audit, not a new
benchmark or a claim that all release time is metadata work.

## Work to do

- Add a small contributor command that prepares a requested version using an
  explicit list of version fields and release-pinned links. Check their agreement
  before the full suite, then create the candidate commit before verifying it.
- Let verification resume on that exact candidate. Retain a receipt outside
  disposable worktrees with commit and tree IDs, runtime/platform, command argv,
  exit codes, elapsed time and explicit skips/not-run entries. A changed source,
  command or required execution context invalidates the corresponding result.
- A retry of preparation or verification must neither create another release
  commit nor move/create a public tag. Refuse a dirty or mismatched candidate
  instead of treating unrelated work as part of the release.
- Update the release guide to use the command and distinguish preparation,
  verification and publication. Keep the existing writer pass and final full
  acceptance; let the separate CI task own Linux qualification and publication.

## Out of scope

- Changing Git-tag distribution to an npm registry, redesigning the tracker,
  adding a general workflow engine, or caching arbitrary test successes.
- Automatically accepting review, waiving failed checks, publishing a release,
  or treating a missing future public tag as a successful installation check.

## Verification

- Fixture tests reproduce the stale overview, installation links and previous
  exact-tag cases. Inconsistent metadata fails before a sentinel full-suite
  command can run; consistent metadata verifies a committed candidate.
- Interrupt after preparation and after a failed verification command. Resume
  the same candidate without duplicate commits/tags or a false PASS. A different
  SHA, dirty tree, command or required runtime invalidates reuse explicitly.
- Exercise release-guide commands in a disposable Git repository, including
  missing/conflicting refs and repeated invocation. Guard the new ordering with
  a check that fails on the old guide.
- Run the configured gates on the final implementation commit. Record skipped
  bodies separately from file counts; no speed target is claimed in this card.
