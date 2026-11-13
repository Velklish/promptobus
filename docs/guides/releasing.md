# Releasing

Prepare a committed candidate, verify that exact candidate, then perform publication acceptance separately. The contributor command never pushes or creates, moves or deletes a tag.

## Technical-writer pass

Run this pass before the release commit.

Run `backslop-writer` in release mode over `git diff <previous tag>..HEAD`. Its default scope covers root `README*.md`, the unreleased section of `CHANGELOG.md`, and `docs/**` except the backlog and archive. This includes `docs/adr/` and `docs/ROADMAP.md`.

The `writer.style` glob in `backslop.json` selects all of `lib/cli.ts`, but the [local writer rule](contributing.md#local-writer-rules) narrows style review to the human-facing `helpText` block. Refusal strings and comments outside that block are not style targets. The `writer.currency` glob adds every shipped skill under `skills/` to currency review only; skills are written for agents and get no style pass.

Record a currency ledger row for each behaviour-changing commit, plus one row for the CLI help and one for every shipped skill. A surface row names the change it was checked against or says `no change touches it`. Record a style ledger row for each `backslop-humanizer` pattern. A release has no writer task, so put both ledgers in the message body of the commit carrying the writer fixes. Commit fixes by document group as the writer skill directs, then review those commits before the release commit.

## Release commit

Finish the writer pass and commit its fixes and the intended `Unreleased` changelog entries first. Start from a clean tree with the pinned dependencies installed (`npm ci`). Choose a new stable version and a release date. Keep receipts on durable storage outside **all** registered Git worktrees, so removing a disposable worktree does not remove the evidence. Replace the example version, date and absolute receipt path below with the intended release values.

```bash
npm run release -- prepare 0.33.0 --date 2026-11-13 --receipt /durable/releases/promptobus-0.33.0.json
```

`prepare` checks that each metadata path exists and is tracked, updates the [explicit version and link list](../reference/01-overview.md#documentation-in-the-package), checks agreement, then commits only those paths as `promptobus X.Y.Z`. Verification runs after this commit, so a previous release's exact tag on the old HEAD cannot conflict with the new package version. The new public tag must be absent when first preparing; an existing target tag refuses preparation. Missing metadata, a missing `Unreleased` heading, a dirty tree or a non-increasing version also refuses.

Repeat the same command after interruption. A matching receipt returns the same candidate without another commit. If interruption happened after the commit but before writing the receipt, the exact release subject plus matching metadata recovers that candidate only if the commit changes listed metadata paths alone. A receipt for another commit, version or date refuses. An interruption before the commit can leave metadata edits; inspect them and restore the intended clean source before retrying. The command does not absorb other work or reset it.

## Verification

```bash
npm run release -- verify --receipt /durable/releases/promptobus-0.33.0.json
```

Before any verification command, metadata must agree and HEAD/tree must match the receipt with no tracked or untracked changes. A present target tag must resolve to that candidate. The fixed argv list is `npm run build`, then the five configured gates: `npm test`, `npx --no-install backslop lint`, `npm run audit`, `npm run pins`, `npm run codex-schema`. A changed gate list refuses; this is not a cache for arbitrary commands.

Each command writes stdout/stderr beside the receipt, with start time, elapsed milliseconds, exit code and signal. The receipt is saved before and after each command. A failure stops verification; later commands remain `notRun`. On retry, matching successful commands are reused, and the failed or interrupted command runs again with a new attempt and new logs. A running or failed attempt never counts as success. Explicit `↷ SKIP` / TAP skip lines and `notRun:` diagnostics are retained separately from successful exits; read the full logs for check and file counts. A zero exit does not turn a skipped body into a passing check.

Reuse requires the same Node version, executable path and hash; npm/Git versions; resolved npm/npx/Git/Codex paths and hashes (including absence); OS release, platform and architecture; installed dependency-lock hash; and a hash of this small environment list: `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `CI`, `PROMPTOBUS_TEST_POOL`, `CODEX_HOME`, `TMPDIR`, `TMP`, `TEMP`. The canonical effective `os.tmpdir()` is recorded too: temporary path length can change test outcomes. Environment values are not stored. Other environment variables do not invalidate receipts. A mismatch refuses reuse; retain the old receipt and repeat `prepare` with a new receipt path to verify every command afresh on the same candidate. Use one invocation per receipt; after a killed process, confirm it has exited before removing its named `.lock` directory.

## Publication acceptance

Retain the technical-writer pass and final full acceptance for the exact candidate, including required platform qualification, review and real installation evidence. The receipt records publication as `notRun`; preparation and local verification do not accept a release. An absent future tag never counts as a successful remote installation check. Linux CI qualification and publication policy remain with CI; this command does not change its triggers or waive checks.

Only after acceptance, create an annotated tag `vX.Y.Z` on the verified candidate with message `promptobus X.Y.Z`, then push the release commit and tag together. A release still uses Git-tag distribution, not an npm registry. Production tagging and publication are separate work; the command and its fixture tests perform neither.
