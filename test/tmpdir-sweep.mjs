// Sweep of sandboxes from cut-off suite runs. Not `*.test.mjs` — the
// runner (run.mjs) takes only those from the directory, so this file
// is not in the run.
//
// A suite file removes its own sandbox with an exit hook
// ([sandbox.mjs](sandbox.mjs)), but a cut-off run is exactly what
// never reaches the hook: Ctrl-C, taken down at the file timeout,
// process crash. The directory stays in system `$TMPDIR` forever —
// nobody sweeps it. Measured 2026-09-03 on the owner's machine: 126
// `ati-*`/`promptobus-*` directories, of them `promptobus-sync-` 23,
// `promptobus-promptobus*` 38, `promptobus-bushook-` 9; some prefixes
// predate the rename, so the leftovers survived more than one release.
//
// **Called from [run.mjs](run.mjs), not from the shared helper
// [check.mjs](check.mjs).** The runner is the only suite process that
// sees the REAL `$TMPDIR`: it sends children `TMPDIR`/`TMP`/`TEMP`
// into the run directory, and `os.tmpdir()` for them returns that.
// A sweep in `check.mjs` would therefore sweep the run directory —
// with live sandboxes of neighbouring files of the same wave — and
// would not touch what piled up in system `$TMPDIR` at all.
//
// Sweep and thresholds are shared with the canary
// ([canary-runs.mjs](../scripts/canary-runs.mjs)): the problem is
// one, and a second copy of the thresholds would drift from the
// first. The one difference is a parameter — `keep = 0`: a suite
// sandbox has no report that is read after the run, and there is no
// reason to keep fresh ones "to read". Only the one-hour age cut-off
// holds them, and it holds the same thing as the canary — a run
// GOING on nearby: a parallel `npm test` or a file started by hand.
//
// **Socket directories under `/tmp` the sweep does not touch, and
// that is not an oversight.** A test socket lives in `/tmp`, not in
// `$TMPDIR`, because of the `sun_path` length limit
// ([sandbox.mjs](sandbox.mjs)), and `/tmp` is a shared system
// directory the whole machine writes to: the suite does not sweep
// there by prefix at all. Socket leftovers are caught by the
// `release-gates.mjs` verdict — "no sockets or run sandboxes left
// after the run"; prefix list and check —
// [sock-prefixes.mjs](sock-prefixes.mjs).
import os from 'node:os';
import { sweepPreviousRuns, sweptLine } from '../scripts/canary-runs.mjs';

// The sweep summary line goes through this module in transit, rather
// than the runner taking it from the shared home directly: a copy of
// `run.mjs` in the [runner.test.mjs](runner.test.mjs) sandbox does
// not see the neighbouring `scripts/` directory at all, and a second
// relative import from there would fail at start. The phrase home
// does not duplicate from that — it stays one.
export { sweptLine };

// Prefixes the suite creates ITSELF — only those we sweep. Collected
// by grepping `makeSandbox('…')` and
// `mkdtempSync(path.join(os.tmpdir(), '…'))` literals in `test/` and
// in the nested-package suite; list completeness is watched by
// [tmpdir-sweep.test.mjs](tmpdir-sweep.test.mjs) — the same grep over
// the directory, the way [runner.test.mjs](runner.test.mjs) watches
// `SERIAL` membership. Without the check a new prefix would leak in
// silence: the list is hand-built.
//
// An entry covers everything that starts with it, so families are
// given by a shared start: `promptobus-promptobus` is `-review-`,
// `-mcp-`, and `promptobus-promptobus spawn-` (the space in the name
// is real); `promptobus-runner-` — the three `runner.test.mjs`
// sandboxes; `promptobus-test-` — also `promptobus-test-run-`, the
// runner run directory.
//
// Foreign ones are not here and must not be: `promptobus-canary-`,
// `promptobus-release-gates-`, `promptobus-live-e2e-`,
// `promptobus-live-cursor-` are created by live runs and release
// gates — they have their own sweep and their own thresholds —
// `agents-review-` is created by production code
// (`headless.js`). **`promptobus-e2e-` is
// shared**: `promptobus-e2e.test.mjs` creates it, and
// `release-gates.mjs` counts such
// directories as live-run sandboxes. The same age cut-off splits
// them: a going gates run is younger than an hour.
//
// Nested-package suite sandboxes (`promptobus-store-` and neighbours)
// ARE on the list, even though another suite creates them. The
// argument is not the file address but where they flow: a hand
// `npm test --prefix cli/packages/promptobus` pours them into the
// same system `$TMPDIR`, and we sweep that, not the suite directory.
// The package does not need its own start point for this: leftovers
// of its hand run will leave on the next repository `npm test`.
export const SUITE_PREFIXES = [
  'promptobus-activation-', 'promptobus-ambient-', 'promptobus-archive-',
  'promptobus-base-', 'promptobus-bgsess-', 'promptobus-bootstrap-', 'promptobus-bushook-',
  'promptobus-check-', 'promptobus-cli-flags-', 'promptobus-codex-', 'promptobus-console-',
  'promptobus-copy-', 'promptobus-cursor-', 'promptobus-doctor-', 'promptobus-driver-',
  'promptobus-e2e-', 'promptobus-env-', 'promptobus-exec-', 'promptobus-external-',
  'promptobus-fresh-', 'promptobus-harness-', 'promptobus-home-', 'promptobus-homedir-',
  'promptobus-hooks-test-', 'promptobus-host-', 'promptobus-lint-', 'promptobus-manifest-',
  'promptobus-mcp-', 'promptobus-migration-', 'promptobus-modules-', 'promptobus-package-',
  'promptobus-plugin-', 'promptobus-promptobus', 'promptobus-publish-', 'promptobus-races-',
  'promptobus-refs-', 'promptobus-review-', 'promptobus-root-', 'promptobus-rules-',
  'promptobus-runner-', 'promptobus-setup-', 'promptobus-skills-', 'promptobus-smoke-',
  'promptobus-store-', 'promptobus-sweep-', 'promptobus-sync-', 'promptobus-test-',
  'promptobus-tools-', 'promptobus-util-', 'promptobus-v1-', 'promptobus-wt-',
  'promptobus-zone-',
];

/**
 * Sweep sandboxes of previous suite runs in `dir`, leaving everything
 * younger than an hour. `current` is the current run directory: this
 * same command created it, and it does not count.
 *
 * Returns the list of what was swept — the caller prints it: a silent
 * sweep in a shared `$TMPDIR` reads as a disappearance. A sweep
 * refusal (directory in use, foreign permissions) does not fail the
 * run and does not take neighbours on the walk — it is caught
 * per-directory inside the sweep itself, and refusing names go into
 * `refused`: sweep here is hygiene, not a gate, and the suite must
 * not go red because of it.
 */
export function sweepTestSandboxes(dir = os.tmpdir(), {
  now = Date.now(), current = null, refused = [],
} = {}) {
  const swept = [];
  for (const prefix of SUITE_PREFIXES) {
    swept.push(...sweepPreviousRuns(dir, { keep: 0, prefix, current, now, refused }));
  }
  return swept.sort();
}
