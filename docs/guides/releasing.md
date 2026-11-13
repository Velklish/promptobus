# Releasing

Prepare a committed candidate, verify that exact candidate, then perform publication acceptance separately. `prepare` and `verify` never push or create, move or delete a tag. After qualification, `publish` creates an annotated tag and pushes it; `smoke` separately checks the installed public ref.

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

Retain the technical-writer pass, independent review and completed local verification receipt for the exact candidate. An absent future tag never counts as a successful remote installation check. Push the clean final candidate to `main` before creating its public tag:

```bash
git push origin HEAD:main
gh run list --repo github.com/Velklish/promptobus --workflow ci.yml --branch main --event push --commit "$(git rev-parse HEAD)"
```

Wait for this candidate's run to finish. Do not automatically rerun failed or cancelled checks: inspect their logs and coordinate the next attempt with the release owner. A source fix needs a new committed candidate, local verification and its own Linux run. Record the exact SHA and run URL. There is one full Linux qualification in the normal release path: `.github/workflows/ci.yml` runs for every main push and pull request, with no version-tag trigger or old-green-run shortcut. Publishing the tag does not trigger another identical suite.

```bash
npm run release -- publish --receipt /durable/releases/promptobus-0.33.0.json --run RUN_ID
```

`publish` requires every local verification command to have passed and a complete fixed-format runtime identity in its local receipt. Missing, null, scalar or incomplete runtime identity refuses before any GitHub call; publication does not rerun local gates or compare the publishing machine to the recorded verification environment. It reads the live GitHub workflow/run and all jobs of that run attempt using `gh`, bound to `github.com/Velklish/promptobus`. The required workflow is `.github/workflows/ci.yml` (`ci`); it must be active and the run must be a completed successful `push` on `main` at the receipt's exact commit. Its required job is `Node 26 / ubuntu-latest`, on the `ubuntu-latest` runner label. The required steps are Install and check tmux, Install dependencies, Install ast-grep, Build, Test, Publicity audit, Pin gate, backslop init and backslop lint. Each must be present once and complete successfully. Missing, running, failed, cancelled, skipped, foreign-repository or foreign-SHA evidence refuses before tag push. Source changes, a changed CI attempt, missing logs or public main moving away from the candidate also refuse.

The receipt retains the run URL, SHA, attempt, required job id, API evidence and raw required-job log beside the local logs. It downloads that job through the [GitHub job-log endpoint](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run), without the rendered `gh run view` output. A successful process exit without a signal or transfer error is required. The raw body must contain the `Run npm test` group, a nonzero equal `N/N test files passed` footer and the later job cleanup marker, in that order. Other-step-only logs, missing Test proof, incomplete transfer or missing terminal output refuse before tag push. Raw bytes, hash and download result remain in the evidence, including failure output; long lines are retained when extracting diagnostics. Explicit skip and `notRun:` diagnostics remain separate: a successful full-suite exit does not mean skipped integration bodies passed. The Linux workflow does not start live account-backed harness runs; the local `codex-schema` gate remains in local verification. Neither a local macOS pass nor a simulated workflow response is Linux qualification.

Only after these checks, `publish` creates the annotated `vX.Y.Z` tag with message `promptobus X.Y.Z` and pushes that tag alone. The receipt records its annotated object and commit. The public tag is immutable: a conflicting object, lightweight tag or target refuses; the command never forces, deletes or replaces it. Distribution remains the public Git tag, not an npm registry.

### Interrupted publication

Repeat the same `publish` command with the same receipt and run id after an interrupted invocation. A local annotated tag left before push is reused only with the same message, object and candidate target. If push succeeded before the receipt was updated, the command checks the existing public annotated object and target, fetching that tag if it is absent locally. It does not push it again or rerun verification. Preserve the receipt and logs; after a killed process, confirm it is gone before removing its `.lock` directory. A CI refusal is not permission to dispatch or rerun a workflow.

### Public installation smoke

Run the separate check after publication:

```bash
npm run release -- smoke --receipt /durable/releases/promptobus-0.33.0.json
```

`smoke` installs `git+https://github.com/Velklish/promptobus.git#vX.Y.Z` with npm in a fresh temporary prefix. It verifies the installed package version, lockfile's resolved commit and installed CLI `--version`, and checks the public annotated object/target before and after installation. Each attempt retains its result and install stdout/stderr outside the temporary prefix. Failure is a release failure to report and investigate; it never retags or replaces the public ref. A repeat `smoke` adds another attempt. Publication recovery and smoke perform no full-suite rerun.
