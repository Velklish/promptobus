# ADR-029: Live runs remove their stand only after owned lifecycle death

**Status:** Accepted
**Date:** 2026-10-03
**Deciders:** repository approver; native account verification remains with the owner.

## Context

The participant live scenarios already reside in the package. The E2E scenario used
one fixed task ID, and its live caller fired stop promises without awaiting them,
then unconditionally removed the sandbox. A handled interrupt skipped that final
block. A later run could discover a session from the interrupted run by the same
name. A dead launcher does not establish that a detached participant died.

The native registry is shared with unrelated sessions. A command line mentioning
a sandbox can belong to a reader, and a PID can be reused. Neither proves ownership.
The abort and orphan fixtures in [live-run.test.mjs](../../test/live-run.test.mjs)
exercise actual Node children, including a parent killed with SIGKILL.

## Options

- Fire stop commands and delete on process exit: quick, but neither session death
  nor process death is confirmed.
- Kill every matching registry name or command-line path: catches more leftovers
  while risking unrelated sessions and readers.
- Persist exact lifecycle evidence and retain unknown state: bounds what cleanup
  may touch and leaves uncertain stands for diagnosis.

## Decision

Use the last option for the E2E live caller. Record spawned child PID, start identity
and dedicated process group. Discover descendants from those identities, never
from text matching. Stop native sessions only by a full session identity bound to
this task and a registry row with the expected private worktree cwd. Preserve the
first observed native PID/start identity and recheck it before stop.

Handled SIGINT, SIGTERM and SIGHUP await the same cleanup as normal completion.
The caller blocks further commands once cleanup starts, waits for owned children,
and escalates only its own child identities to SIGKILL. A failed registry read,
stop, identity check or death check retains the stand. Loss of any recorded process latches incomplete ancestry and retains the stand even
after every recorded PID dies. A successful native stop or delivered child signal
does not establish that its descendants all died. A detached descendant may have escaped into a new
process group before its parent vanished; PID/group snapshots cannot establish the
absence of arbitrary unobserved descendants. Shared native daemons are
never signalled; a recorded native PID still alive conservatively retains it.

The shared sweep takes this caller's liveness predicate. An old run without a
confirmed lifecycle, including one whose parent was hard-killed, is held. Elapsed time does not make an uncertain lifecycle eligible. Even a
record marked dead requires a fresh process check before removal.

Every participant live scenario uses the canonical task identity function with a
random run slug. That identity is also its visible work title, so the worker and
reviewer registry names distinguish consecutive runs in the same clock second.
Cursor keeps the host state-home route. Consumer layout wrappers stay in their own
repository until the package revision is accepted and delivered.

## Consequences

Safe cleanup may preserve a stand instead of claiming a successful removal. Its
private lifecycle record and report identify that boundary. Unknown historical
stands need diagnosis; this decision does not authorize killing foreign processes
or changing native account configuration.

Node fixtures establish lifecycle and abort behaviour. They do not establish a
successful native account run. Participant native probes remain owner-run and are
not part of the automatic suite.
