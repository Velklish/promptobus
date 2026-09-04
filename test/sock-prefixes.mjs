// Socket prefixes for the release-gate sweep verdict. Not
// `*.test.mjs` — the runner takes only those from the directory, so
// this file is not in the run.
//
// Unix-socket directories live in `/tmp`, not in the run `$TMPDIR`:
// the `sun_path` limit ([sandbox.mjs](sandbox.mjs)). The suite sweep
// does not sweep them — `/tmp` is shared, foreign things must not be
// removed. A cut-off run's leftover is caught by the
// [release-gates.mjs](../scripts/release-gates.mjs) verdict "no
// sockets left after the run": it looks at `/tmp` by this list.
//
// The list is hand-built, like `SUITE_PREFIXES`. Completeness is
// watched by [tmpdir-sweep.test.mjs](tmpdir-sweep.test.mjs): every
// `makeSockPath('…')` and `makeSockDir('…')` literal in `test/` and
// `scripts/` must start with one of the entries. Without the check a
// new prefix would leak in silence — a live case: `ags-` in
// `promptobus-guard.test.mjs` was not in the gate literal.
export const SOCK_PREFIXES = ['a2l-', 'a2e-', 'a2h-', 'a2s-', 'adoc-', 'ags-', 'a2m-'];
