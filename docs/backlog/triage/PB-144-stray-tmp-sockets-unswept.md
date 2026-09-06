# PB-144 · Nothing in promptobus's own test run sweeps the stray socket directories it leaves in shared /tmp — the release-gate verdict that used to catch this now lives only in ati-agents

- **Scope:** `test/sock-prefixes.mjs`, `test/tmpdir-sweep.mjs`, `test/tmpdir-sweep.test.mjs`, `test/run.mjs`, `scripts/canary-runs.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`find . -iname "*release-gate*"` in this repository (v0.5.0, no CI config of any kind present) returns nothing. The file exists only at `/Users/kim.p/AtiWorkspace/workspace/repos/agent-workspace/ati-agents/cli/scripts/release-gates.mjs`, which imports its own copy of `SOCK_PREFIXES` from `cli/test/sock-prefixes.mjs` and runs `younger('/tmp', SOCK_PREFIXES)` at `release-gates.mjs:547` as a release verdict for the ati-agents *package* — not for anything this repository runs, tests, or gates on its own.

`test/sock-prefixes.mjs:1-18` still describes the pre-split architecture: its header says 'A cut-off run's leftover is caught by the `release-gates.mjs` verdict ... it looks at `/tmp` by this list' as if that file lived here. It does not, and never will without a change: this repository is a library with no release-gate script of its own.

`test/tmpdir-sweep.test.mjs:97-106` already special-cases the missing file, but only for the sweep it actually asserts: the check titled 'release-gates.mjs is not in this repository — suite sweep is owned by run.mjs' verifies that `test/run.mjs` calls `sweepTestSandboxes(os.tmpdir(), ...)` (confirmed live at `test/run.mjs:93`) — i.e. it certifies the `$TMPDIR` sandbox sweep exists. It asserts nothing about `/tmp` sockets. Grepping `test/run.mjs` and `test/tmpdir-sweep.mjs` for `'/tmp'` confirms neither ever touches that path, only `os.tmpdir()`.

So today nothing in this repository's own suite, its `sweepPreviousRuns` helper (`scripts/canary-runs.mjs`), or any CI it runs sweeps `/tmp` for the socket directories `SOCK_PREFIXES` names. Re-measured now, 2026-09-06, on the machine this audit ran on: `ls /tmp | grep -E '^(a2l-|a2e-|a2h-|a2s-|adoc-|ags-|a2m-)'` finds 12 directories (`a2e-`×5, `a2m-`×3, `a2h-`×1, `a2l-`×1, `adoc-`×1, `ags-`×1); `stat -f %T` confirms each is a directory, not a leftover file, and `stat -f %Sm` dates them from 2026-09-02 through 2026-09-06 11:03 — all more than six hours old at the time of this check, so none belongs to a run still in flight.

## Work to do

- Add one more `sweepPreviousRuns`-shaped call to `test/run.mjs`, next to the existing `sweepTestSandboxes(os.tmpdir(), ...)` call, that sweeps `/tmp` by `SOCK_PREFIXES` under an age cut-off — the same verdict shape `younger('/tmp', SOCK_PREFIXES)` gives in ati-agents' `release-gates.mjs`, so a cut-off run's socket directory does not outlive the run that made it by more than a suite run's length.
- Rewrite the header comment in `test/sock-prefixes.mjs` to stop describing a `release-gates.mjs` 'in this repository' — name the sweep that actually owns the list after the change (`test/run.mjs`, or wherever the new call lands).
- Add a CHANGELOG entry under `## [Unreleased]` once the sweep lands, since it changes what a suite run does to the filesystem outside its own sandbox.

## Out of scope

- Porting `release-gates.mjs` itself into this repository, or standing up CI to hang a release gate on: this repository has neither today, and duplicating a full release-gate script here would need to be kept in sync with ati-agents' copy by hand for a problem `test/run.mjs` already solves for `$TMPDIR`.
- The 12 directories already on this machine: they predate any fix and no test-time gate will reach them — clearing them is a one-off, not part of this change.

## Verification

- After the change, seed `/tmp` with a fake stale directory matching one of `SOCK_PREFIXES` (mtime older than the cut-off) and run the suite: the new sweep removes it and the run's own summary line names it, the way `sweepTestSandboxes` already reports what it swept.
- A directory matching a prefix but younger than the cut-off, or one belonging to the run currently executing, survives the sweep.
- `node --test test/tmpdir-sweep.test.mjs` stays green, and its existing missing-file fallback check is updated (or a new check added) to assert the `/tmp` sweep call exists in `test/run.mjs`.
