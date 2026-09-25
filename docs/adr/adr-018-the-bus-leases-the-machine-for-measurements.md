# ADR-018: The bus leases the machine for measurements

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** the owner decided that the bus owns the lease (2026-09-25, recorded in the card of PB-241); the worker of that card settled the design points below, which the owner's decision left open.

## Context

The bus lifts several participants at once, each in its own worktree. Their trees are isolated;
the machine is not. Whatever they measure — a performance gate, a wall-clock assertion, a suite
with a timeout — is measured on a box the others are loading. The card records a run where three
workers of one task gated at once and the one-minute load average reached 63 on eight cores:
every number of that window was worthless, and its reds cost review rounds to explain.

Runs worked around it by convention: an orchestrator-issued slot, or `mkdir /tmp/<name>.lock` as
a mutex. An empty directory carries neither pid nor timestamp, so a waiter cannot tell "someone is
measuring" from "someone was killed and left the directory"; it is invisible to `status`; and it
reaches a participant only as prose in a brief — which one participant of that run had not yet
received when it entered the window.

The owner decided on 2026-09-25 that the bus owns it: a machine-wide lease with a holder and a
timestamp; `status` names the holder and since when; a holder that is gone releases it by
liveness; participants learn of it from the preamble the bus gives them. What was left to decide
is where the lease lives, what the door is, how a waiter waits, what `status` prints, and what
the preambles say.

## Options

**Decision 1 — where the lease lives.**

- **1A — in the store home** (`promptobusHome()`). Rejected: the home is per workspace, and
  participants of different workspaces load the same box — two orchestrations of two workspaces
  ran side by side on the machine this was decided on. A lease one of them cannot see is no lease.
- **1B — under the user home** (`~/.promptobus/…`). Rejected: `HOME` is diverted as readily as
  `TMPDIR` — this repository's suite runner gives every file a home of its own — and a lock there
  outlives a reboot, after which a reused pid would read as a live holder.
- **1C — under `os.tmpdir()`.** Rejected: `TMPDIR` is exactly the variable a runner or a harness
  diverts — this repository's own suite runner points every child's `TMPDIR` into its run
  directory — so two participants could each see a lease of their own.
- **1D — one fixed directory per user of the machine: `/tmp/promptobus-<uid>/`** (on Windows,
  where there is no `/tmp`, `%TEMP%\promptobus-lease`), overridden only by `PROMPTOBUS_LEASE_DIR`.
  Chosen. It is the same path for every process of the user whatever its workspace, harness or
  `TMPDIR`. It is per user rather than one for all users because `/tmp` is sticky: a process of
  another user could neither remove a dead holder's directory nor ever acquire it. The path is
  predictable, so another user can create it first — and then drop our lock mid-measurement or
  plant one naming a live pid. The lease therefore trusts the directory only after checking it:
  created with mode `0700` if absent, then `lstat`, and a refusal that runs nothing when it is a
  symbolic link, not a directory, or owned by another uid. The override exists for tests, which
  must not wait on the lease that a real run holds around them.

**Decision 2 — the door.**

- **2A — acquire and release verbs.** Rejected: a participant that acquires and then ends its
  turn, fails a step or is killed between the two leaks the lease until someone notices, and a
  lease whose holder is "the session" has no pid for liveness to read.
- **2B — an MCP tool.** Rejected: it changes the tool contract every participant sees, and the
  MCP server's pid is not the pid of the run — its liveness says nothing about the measurement.
- **2C — a wrapper: `promptobus lease -- <command…>`.** Chosen. It takes the lease, runs the
  command, and releases on the command's exit; the holder is the wrapper's own pid, which is alive
  exactly as long as the run is. It cannot leak: every exit path of the wrapper releases, and the
  one that does not — the wrapper killed with SIGKILL — leaves a pid that `kill 0` no longer
  reaches, so the next taker drops the lock. A signal the wrapper can catch (INT, TERM, HUP) is
  forwarded to the command, and the lease is released only after the command has exited: the
  killed run is still on the machine until then.

The lock primitive is the one the task journal already trusts (`src/fs/lock.ts`): an atomic
`mkdir`, an owner file with pid and time, a dead holder dropped by pid liveness with a `rename`
aside, never by age. The lease adds one file beside the owner — `holder.json`, naming the
address, task, command and working directory — for display only; liveness is read from the
owner file alone.

**Decision 3 — waiting.**

A waiter polls the lock every 250 ms. Once the holder's record exists, and again whenever the
holder changes, it prints one line to stderr naming the holder — address, task, command, since when and
for how long, pid — and the bound. Past the bound (`--wait <seconds>`, default 1800) it fails with
that same line, exit 1, and runs nothing. The default is measured against the work it guards: a
full suite of this repository takes about three minutes on an idle machine, so thirty minutes is
several holders in a row; a longer wait is a holder that has stopped, and the line names its pid
for a person to look at. A holder caught between its `mkdir` and its `holder.json` is not
announced: a line printed then would name nobody and would not be printed again for that pid, so
the waiter stays silent until the record lands. A waiter records itself in `waiters/<pid>.json` while it waits; a
waiter's record whose pid is gone is not listed.

**Decision 4 — visibility.** `promptobus status` opens with the lease, before any task and even
when no task is active, since the lease is not a task's: `machine lease: free (<path>)`, or
`held by <address> (task <id>) · <command> · since <time> (<age>) · pid <n>`, or `left by a dead
process — …; the next taker drops it`, then one `waiting — …` line per live waiter.

**Decision 5 — who is told, and what counts as a measurement.** The worker preamble (`spawn`)
and the approver preamble (`review --approver`, which runs the full gates on the merged tree)
carry a `## Machine lease` section with the command already addressed — `lease --as <address>
--task <id> -- <command…>` — and one definition: a measuring command is one whose outcome depends
on wall-clock or machine load, which in any repository means its full test suite and its gate
command as that repository's own AGENTS.md, README or contributing guide names them; a single
test file, a lint, a build or a type check is not. The reviewer preamble says only that the lease
is not its own: a reviewer runs nothing. No configuration schema lists the measuring commands:
each repository already names its gates, and a second list would drift from the first.

## Decision

1D, 2C, and the waiting, visibility and preamble rules above. The orchestration skill says once
that the lease exists and that it replaces orchestrator-issued slots.

## Consequences

- A participant of any task, workspace or harness sees the same lease as long as it runs as the
  same user; participants of different users of one machine do not see each other's.
- A wrapper killed with SIGKILL leaves its command running as an orphan, and the lease is dropped
  while that orphan may still load the machine. A kill of the whole process group takes the
  command with it; whether a harness kills a session that way was not measured here.
- On Windows there is no `process.getuid`, so the owner check of the lease directory is skipped
  there; the symbolic-link and not-a-directory refusals still apply.
- A pid reused while a dead holder's lock still stands reads as a live holder; the bound turns
  that into a refusal that names the pid instead of a hang.
- A command leased inside another leased command waits for the outer one until the bound; the
  preamble says not to nest.
- How many participants may run at once stays the orchestrator's call; the lease only serialises
  the measuring runs among them.
