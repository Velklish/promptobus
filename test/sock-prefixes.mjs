// Socket prefixes for the suite-run sweep in `test/run.mjs`. Not
// `*.test.mjs` — the runner takes only those from the directory, so
// this file is not in the run.
//
// Unix-socket directories live in `/tmp`, not in the run `$TMPDIR`:
// the `sun_path` limit ([sandbox.mjs](sandbox.mjs)). The runner sweeps
// them by this list at start, using a socket probe to preserve a live
// neighbouring session. A cut-off run's leftover is therefore handled
// by the same runner that sweeps its `$TMPDIR` sandboxes.
//
// The list is hand-built in the shared sweep helper, like `SUITE_PREFIXES`. Completeness is
// watched by [tmpdir-sweep.test.mjs](tmpdir-sweep.test.mjs): every
// `makeSockPath('…')` and `makeSockDir('…')` literal in `test/` and
// `scripts/` must start with one of the entries. Without the check a
// new prefix would leak in silence — a live case: `ags-` in
// `promptobus-guard.test.mjs` was not in the gate literal.
export { SOCK_PREFIXES } from '../scripts/canary-runs.mjs';
