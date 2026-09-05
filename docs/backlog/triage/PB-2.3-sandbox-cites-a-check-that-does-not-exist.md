# PB-2.3 · `sandbox.mjs` cites a check that is not in the tree

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none

## Context

Found while doing PB-2.2. Attached to PB-2 because a finding attaches to a task and
not to another finding; its real subject is PB-2.2's load-order rule.

`test/sandbox.mjs` lines 52–56 explain why its static CLI import is safe, and close
the explanation with the name of a check:

```js
// Static CLI import — before HOME hygiene in home.mjs and before the
// swap in the suite file. A module that computes os.homedir() into a
// load-time constant would see the real home (home paths are computed
// at call time; the class is caught by homedir-module.test.mjs).
import { resetBgSessionsCache } from '../lib/liftoff.js';
```

That file does not exist, and nothing else checks the class either:

```text
$ ls test/homedir-module.test.mjs
ls: test/homedir-module.test.mjs: No such file or directory

$ grep -rn "homedir-module" test/ docs/
test/sandbox.mjs:55:// at call time; the class is caught by homedir-module.test.mjs).

$ grep -rn "homedir()" test/*.test.mjs
test/host.test.mjs:180,185,239,240      (assertions about routing and state-home paths)
test/model-routing.test.mjs:330         (a path substitution in a golden comparison)
```

Four hits, all of them assertions about the paths a host answers — none of them
about a package module computing a home path at load time.

The audit's link checker does not reach this: it follows markdown-style `](…)`
links (`scripts/audit-public.mjs`, the `LINK` pattern), and a bare filename in
prose is not one. So the citation can name anything.

Why it matters rather than being a stale comment. PB-2.2 made
[test/home.mjs](../../../test/home.mjs) the one apply point of the home diversion
and requires it to be the FIRST import of every suite file, for exactly the reason
the quoted comment gives: a module that resolved a home path at load would capture
the real home before the diversion runs. That rule now rests on a claim with
nothing behind it. It is very likely TRUE — the package resolves home at call time
today — but "likely true" is what the repository asks to be turned into evidence or
marked as an assumption.

## Work to do

- Decide which the rule actually rests on and make the text match:
  - if the property is worth a gate, write the check the comment already names —
    a scan of `lib/**` and `src/**` for a module-scope constant computed from
    `os.homedir()`, `os.userInfo()` or `process.env.HOME`, in the shape the
    sweep-prefix and socket-prefix sentinels in `tmpdir-sweep.test.mjs` use;
  - if it is not, correct the citation to say what actually holds the property
    (today: nothing does, and home paths are computed at call time by convention).
- Either way the same sentence appears in [test/home.mjs](../../../test/home.mjs),
  which cites `sandbox.mjs` for it; that file changes with the decision.

## Out of scope

- The diversion itself and its gate — PB-2.2 closed those, and this is about the
  claim that the load-order rule leans on.
- Widening the audit's link checker to bare filenames. That is a separate question
  about a different tool, and it would report far more than this one line.

## Verification

- `grep -rn "homedir-module" test/` returns nothing, or returns a file that exists.
- If a check is written: a mutation probe plants a module-scope
  `const HOME = os.homedir()` in a package file and the check names that file.
