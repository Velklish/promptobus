# ADR-035 · Separate factual BB workflow admission from explicit logical acceptance

**Status:** Accepted
**Date:** 2026-10-08

## Context

A generic participant binding establishes identity and execution ownership, not
permission to start acceptance without predecessor results. The native pipeline
already checks recorded subject, current assignment and a subsequent result.
It does not judge verdict text, commits or the truth of supplied gate records.
The BB facade must keep that distinction across dispatch, reload and tool calls.

## Decision

The minimal default is the existing task owner as executor and a fresh independent
reviewer. Predictable checks, evidence assembly and integration bookkeeping use
authorized code. An additional role requires an explicit responsibility. The
global pipeline and optional approver's predecessor admission remain unchanged.

An approver explicitly selects its worker and isolated reviewer. The authenticated
host projects their canonical BB identity, actual subject and latest task assignment
into the existing native `requireStepResults` check through `BbHostIntegration.checkStep`.
Result lookup uses the participant's canonical id, independent of its adapter
address. The native adapter already uses that id, so its admission semantics stay
the same. Missing, stale or different-subject results refuse. An opaque negative
verdict remains a recorded fact; an agent or operator judges acceptance.

Check admission before reservation/spawn, after asynchronous environment preparation,
at dispatch and before approver tool calls. Preserve selected predecessors in the
binding and canonical launch metadata. Current assignment uses the persisted
causal boundary and any later canonical task/review assignment. Legacy records
without a causal boundary do not receive an invented floor. Unread records are validated without
isolation; read-history listing is strict, and quarantined mailbox records refuse
admission until the operator repairs the incomplete journal.

Explicit owner `task accept` is a separate logical decision boundary. It requires
the exact latest independent reviewer result after the current assignment, a
strict structured PASS with zero critical/major findings, exact current
source/base/producer/manifest identity and revalidated required passing evidence.
The result keeps the complete bounded report; one reserved decision line precedes
its completion marker and all-calls release. Ordinary negative or prose results
remain authentic facts and do not become acceptance.

Current owner authority and canonical binding are checked again under the existing
task lock after asynchronous evidence reads, before the status append. A valid
finished reviewer grant can remain ended. The journal record explicitly retains
`physicalClose: false`; it does not prove report completeness, Stop, drained calls,
task done or delivery. The owner still reads the full report and judges its truth.
SDK/source checks are point-in-time, with no continuous external source-write lock.

Full support is a profile claim: six standing roles, authenticated transport,
restricted reviewer, actual Host delivery, lifecycle preservation and recoverable
wake must be observed together. A mixed native reviewer does not prove full BB.
Publish versions, local host and default-pipeline scope, remaining SDK limits and
source-only delivery status alongside the captures.

## Consequences

The shared predecessor gate continues to check journal facts only. Explicit
logical acceptance binds a typed independent decision to current evidence; it
does not mechanically grade code or create a new transaction guarantee spanning
BB and external source writes. Consumers still judge artifact and gate truth and preserve source
before resource retirement. A configured pipeline without the shipped approver
step refuses this facade; custom BB pipeline role names remain unsupported.
