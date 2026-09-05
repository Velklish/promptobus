# PB-17.1 · The codex driver test counts holder and app-server processes machine-wide, so a neighbouring checkout reddens it

- **Scope:** [promptobus-driver-codex.test.mjs](../../../test/promptobus-driver-codex.test.mjs)
- **Created:** 2026-09-05
- **Dependencies:** none

## Context

Found during PB-17. `promptobus-driver-codex.test.mjs` checks that a refused lift
leaves no processes behind by counting them with `pgrep -f`:

```js
const beforeHold = pgrep('codex-hold.js');
const beforeApp = pgrep('app-server --stdio');
…
const extraHold = pgrep('codex-hold.js').filter((p) => !beforeHold.includes(p));
const extraApp = pgrep('app-server --stdio').filter((p) => !beforeApp.includes(p));
check(': after a lift refusal there are no holder processes', …);
```

Both patterns are machine-wide. Anything on the machine that starts a Codex holder
or an app-server between the two calls is counted as this file's leak — including
another checkout running the same suite.

Measured 2026-09-05, three routing tracks running `npm test` in parallel worktrees:
the file went red with `hold 85427 · app 85763`, and the processes alive from that
same window belonged to a different worktree —

```text
$ pgrep -fl codex-hold.js
86034 … /promptobus-model-routing-v1-in-adapter-claude-…/lib/codex-hold.js …
$ pgrep -fl 'app-server --stdio'
86149 … /T/promptobus-test-run-Cv8ya1/promptobus-promptobus-mixed-…/bin/codex.stub.mjs app-server --stdio
```

The same file run alone is green (56/56), and the same full suite was green on the
run before. Nothing in the checkout under test had changed between the two runs.

This is the class PB-14.4 named for the Cursor wake test: a pooled check that reads
a MACHINE-wide fact and calls what it finds its own.

## Work to do

- Scope both patterns to the file's own sandbox — the stub's argv carries its bin
  directory (`…/promptobus-codex-<rnd>/bin/codex.stub.mjs`), and the holder's argv
  carries its session file under the same sandbox, so either is enough to tell one
  suite run from another.
- Look for the same shape elsewhere before closing: a `pgrep` without a sandbox
  path is the pattern, not this one line.

## Out of scope

- The lift-refusal behaviour itself, which is correct and is not what goes red.
- Serialising the suite. The check does not need the machine to itself; it needs to
  stop asking about the machine.

## Verification

- The file green while a second checkout runs its own `npm test` — the condition
  that reproduces the red.
- A mutation probe: leave a holder alive on purpose in the sandbox and the check
  still goes red, so the narrowing did not turn it off.
