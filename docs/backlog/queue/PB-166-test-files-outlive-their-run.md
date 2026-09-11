# PB-166 · A suite file that finished its work keeps the process alive, and a dead session leaves it orphaned forever

- **Order:** 68
- **Scope:** `test/run.mjs`, `test/sandbox.mjs`, the suite files themselves, [contributing](../../guides/contributing.md)
- **Created:** 2026-09-11
- **Dependencies:** none

## Context

Measured on the owner's machine 2026-09-11, at the end of run 0911e. Five orphaned node
processes, every one of them `PPID 1`, all older than the run and older than the sessions
that could have started them:

| PID | Command | Age | CPU time | %CPU |
|---|---|---|---|---|
| 83719 | `node test/promptobus-host.test.mjs` | 2 d 2 h | **2618 min** | **100** |
| 18160 | `node --test test/zz-hang.test.mjs` | 2 d 6 h | 2.3 s | 0 |
| 18268 | child runner of 18160 | 2 d 6 h | 2.3 s | 0 |
| 42315 | `node --test test/review.test.mjs` | 2 d 6 h | 2.4 s | 0 |
| 42318 | child runner of 42315 | 2 d 6 h | 2.4 s | 0 |

The machine had been up 2 d 8 h, so they had been there for almost its whole life. The
spinner had burned **43.6 hours of a core** and held the machine's baseline load average
between 8 and 14 all evening — every gate measurement of run 0911e was taken over that
floor. `kill` (SIGTERM) did not touch it; `kill -9` did, which says the process never
returned to its event loop and no JS signal handler ever ran. The other four were idle:
their work was over and something kept the loop alive.

Two shapes, one consequence: a suite file that does not exit on its own becomes immortal
the moment its parent dies.

**What is NOT established.** Which repository each orphan came from — `promptobus-host.test.mjs`
exists in this repository as `test/` and in the consumer as `cli/test/`, and the relative
path in `ps` fits either, depending on the cwd. `zz-hang.test.mjs` and `review.test.mjs` do
not exist in either repository today. Whose session started them, and how that session
ended, is likewise unknown: the processes were killed before anything was read off them.
Next time, before killing: `lsof -p <pid> | grep cwd` and `ps -o lstart= -p <pid>`.

**What the suite already does, and why it did not help.** `test/run.mjs` gives every file a
300 s deadline and takes a late one down with SIGKILL, and it kills live children on
interrupt. That protects `npm test`. It does not protect a **single-file run** — `node
test/<file>.test.mjs` — which is the form the rules prescribe for a mutation probe, and
which has no deadline, no child bookkeeping and no parent to notice.

## What to do

- Make a finished file exit. Find what holds the loop open after the last check — an unclosed
  socket, a live child, a timer — and close it. `process.exitCode` plus a natural exit, not
  `process.exit()`: the latter would hide the defect rather than fix it.
- Give the suite a gate for it. A file whose process is still alive N seconds after its last
  verdict is a defect of that file, and the runner is where it is visible.
- Decide what a single-file run gets. Options, and they are not equivalent: a deadline inside
  the shared helper every file already imports; or a documented rule that a probe is run
  through the runner with a file filter rather than by hand; or nothing, stated out loud, with
  the orphan risk named in [contributing](../../guides/contributing.md).
- Establish whether a killed participant session takes its children with it. If `claude stop`
  and `promptobus done` leave a worker's grandchildren behind, that is a second source of the
  same orphans and it lives in this package's `stop`, not in a test file.

## Out of scope

- The consumer's own suite (`cli/test/run.mjs`): it carries the same 300 s deadline and the
  same single-file gap, but it is a different repository. Mirror the decision there once it
  is made here.
- Hunting the individual dead processes listed above: they are gone, and the evidence that
  survives them is in this card.

## Checks

- A file deliberately left with an open handle is reported by the runner instead of hanging
  or leaking.
- After a full `npm test`, no node process from the suite remains: count before and after.
- Whatever is decided for a single-file run, it is stated in the reference, and a probe run by
  the prescribed form leaves nothing behind.
