# ADR-012: Stopping one participant is a verb of its own, not a flag on `done` or `dismiss`

**Status:** Accepted
**Date:** 2026-09-12
**Deciders:** the run's orchestrator, under the owner's standing mandate of 2026-09-12 — "decide the forks yourself and record them as ADRs with the rejected options". **Not reviewed by the owner**: this line says so because an ADR outlives the night it was written in, and a decision recorded under someone's name is read later as theirs.

## Context

A run needed to stop one of a task's two participants and had no command for it. `done`
closes the task and stops every session in it, the other participant included; `dismiss <address>`
stops the warden's reports about one address and never touches its process, which is what it
promises and the right behaviour for what it is. Between them there was nothing.

So the worker killed the holder by hand, from the pids in the Codex registry record: 172 MB
freed — a 45 MB holder and its 127 MB `app-server` — on a machine at 89.3 % swap under four
workers. The record stayed at `state: alive`, and only `done` on
that task would ever clear it, so anything reading the registry for liveness after that read a
session that did not exist. That is the same shape as a contact-point file that outlives the session it names,
and the two differ in where the cure lives: a contact point has an externally checkable sign
beside it (its socket), so its READER can be fixed; a registry record has none, and only the
thing that stops the session can retire it.

## Options

**A — `promptobus stop <address>`, a verb of its own.** One more command in the surface, and its
boundary against the two neighbours has to be said out loud.

**B — `dismiss --stop`.** Rejected. `dismiss` was documented in this same release as "the watch
only, the process is not touched", and a flag that makes it kill a process would contradict that
sentence in the run that wrote it. Two behaviours under one name is worse than a second name —
the reader of `dismiss` in a script cannot tell which one they are looking at without reading the
flags.

**C — `done --only <address>`.** Rejected. `done` promises the whole task: it closes the task,
sweeps worktrees, appends telemetry and prunes journals. A subset flag makes every one of those
promises conditional on a flag the reader has to notice, and the first such flag invites the
second.

**D — leave it to a hand `kill`.** Rejected by the measurement above: a hand kill cannot retire
the record, because the record's owner is the driver.

## Decision

**A.** `promptobus stop <address>` closes one participant's session and leaves the task open.

- **Authority follows the operation.** The task mailbox owner alone can call `done`. The owner or an approver bound to its own recorded session on that task can call `stop` and `dismiss`.
- **It refuses an unknown or attached participant.** The refusal names known addresses or explains
  that the person's own session was not started by the mechanism. A managed orchestrator is eligible
  under the same owner gate. Each refusal is checked by its exit and by the driver not being called.
- **An absent session is ordinarily a no-op.** Codex still requires terminal command accounting. Unknown accounting retains the launch record even if its process has exited.
- **Confirmed Stop retires the disposable session record through the driver.** Retained lifecycle receipts remain available for verification.
- **An unconfirmed stop is not a confirmed closure.** A synchronous Stop that cannot confirm the
  session is gone exits non-zero and retains the record. A managed Codex orchestrator requesting its
  own Stop receives a pending acknowledgement; confirmation follows actual command completion and
  app-server closure. Another authorized session can inspect the retained proof.
- **The watch is untouched.** `stop` does not do `dismiss`'s work behind its back, and the
  suite asserts the participant is still watched after its session is stopped.

## Consequences

For a finite managed Codex tree, the root stops its owned teamleads and retains their
results before requesting its own Stop. An authorized observer inspects the retained
completion proof, not just the pending acknowledgement. Native Stop, task metadata
closure and service shutdown are separate operations; `done --keep-sessions` is not
a way around the Stop prerequisite. See the [scoped service route](../reference/03-cli.md#shared-service).

- The surface gains one verb, and the help of all three now states the boundary in one breath:
  `done` is the task, `stop` is one session, `dismiss` is the watch.
- The memory a stuck participant holds can be reclaimed without ending the run — the case that
  produced the card.
- **A session the mechanism did not start still cannot be stopped by it**, by design. A person
  who lifted their own window closes their own window.
- **What this does not give:** a way to stop a participant of somebody else's task. The owner
  gate is deliberate, and a run that needs it should ask the owner rather than gain a flag.
- The rule the measurement leaves behind is larger than the command and is recorded in `03-cli`:
  an artefact written at birth — a registry record, a contact point file — is not erased at death
  by anything but the mechanism that wrote it. Read liveness from the process, or from a sign
  that can be checked from outside, and never from the artefact's own existence.
