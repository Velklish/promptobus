# ADR-035 · Keep BB workflow admission factual and publish the measured Codex profile

**Status:** Accepted
**Date:** 2026-10-08

## Context

A generic participant binding establishes identity and execution ownership, not
permission to start acceptance without predecessor results. The native pipeline
already checks recorded subject, current assignment and a subsequent result.
It does not judge verdict text, commits or the truth of supplied gate records.
The BB facade must keep that distinction across dispatch, reload and tool calls.

## Decision

An approver explicitly selects its worker and isolated reviewer. The authenticated
host projects their canonical BB identity, actual subject and latest task assignment
into the existing native `requireStepResults` check through `BbHostIntegration.checkStep`.
Result lookup uses the participant's canonical id, independent of its adapter
address. The native adapter already uses that id, so its admission semantics stay
the same. Missing, stale or different-subject results refuse. An opaque negative
verdict remains a recorded fact; an agent or operator judges acceptance.

Check admission before reservation/spawn, after asynchronous environment preparation,
at dispatch and before approver tool calls. Preserve selected predecessors in the
binding and canonical launch metadata. Current assignment is the latest canonical
task message, or the recorded initial assignment time. Legacy records without
that time do not receive an invented floor. Unread records are validated without
isolation; read-history listing is strict, and quarantined mailbox records refuse
admission until the operator repairs the incomplete journal.

Full support is a profile claim: six standing roles, authenticated transport,
restricted reviewer, actual Host delivery, lifecycle preservation and recoverable
wake must be observed together. A mixed native reviewer does not prove full BB.
Publish versions, local host and default-pipeline scope, remaining SDK limits and
source-only delivery status alongside the captures.

## Consequences

The shared gate checks journal facts only and keeps timestamp precision unchanged.
No content grading, automatic source acceptance or new transaction guarantee is
introduced. Consumers still judge artifact and gate truth and preserve source
before resource retirement. A configured pipeline without the shipped approver
step refuses this facade; custom BB pipeline role names remain unsupported.
