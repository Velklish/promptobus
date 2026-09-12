# PB-199 · The sweep test demands an absolute temp path of production and then makes its own fixtures in the working directory

- **Order:** 60
- **Scope:** `test/tmpdir-sweep.test.mjs`
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

`test/tmpdir-sweep.test.mjs:102` asserts, of production code, exactly this:

```js
/mkdtempSync\(path\.join\(os\.tmpdir\(\), RUN_PREFIX\)\)/.test(gatesSrc)
```

— the run directory must be made under the system temp directory, by absolute path. Two lines of
the same file then do the opposite for its own fixtures:

```js
200:  const OWNER_FIXTURE  = mkdtempSync('promptobus-sweep-owner-');
237:  const SOCKET_FIXTURE = mkdtempSync('promptobus-sweep-socket-');
```

A bare prefix is not a temp path. Node resolves it against `process.cwd()`, so both fixtures are
created **in the working directory** — the checked-out tree — not in `$TMPDIR`.

Two consequences, and the second is the one that surfaced it:

- for a runner whose working directory is writable the directories are simply created there, and
  the suite litters the tree it is testing;
- for a participant of the bus the shell cannot write its own working tree at all, so the call
  fails `EPERM` and the file yields **no verdicts whatsoever**. This is measured: the refusal was
  filed for three months under a class of `EPERM` failures whose only common trait was the text of
  the error, and it left that class the moment anyone asked where the path pointed.

The rule the file states for production is the right rule. It is simply not applied to the file
itself.

## Work to do

- Build both fixture paths with `path.join(os.tmpdir(), …)`, as the assertion at `:102` already
  requires of production.
- Check the rest of the suite the same way — `:383` says a grep runs "in both directions" over
  `makeSandbox(…)` and every `mkdtemp`, which is the natural place to make a relative prefix
  impossible rather than merely absent today.

## Out of scope

- The participant sandbox boundaries themselves. That a participant's shell cannot write its own
  worktree is recorded elsewhere; here it is only the thing that made the defect visible.
- The three `listen` refusals that travelled under the same class name. They are a network
  boundary and share nothing with this.

## Verification

- A red check on the shape, not on the outcome: a bare prefix passed to the fixture helper must
  fail the suite by name. A test that only checks "the directory exists" passes either way and
  proves nothing.
- A mutation probe aimed at that check: restoring a relative prefix in one fixture must redden
  exactly that verdict. A green probe here condemns the check.
- `node test/tmpdir-sweep.test.mjs` with the working directory set somewhere read-only — the file
  must still produce its verdicts.
