# ADR-032: BB delivery is a replayable bounded hint to canonical mail

**Status:** Accepted
**Date:** 2026-10-08
**Deciders:** Repository owner (explicit plugin Stop policy); implementation: Codex

## Context

Promptobus owns message fan-out, immutable artifacts and read ACK. SDK0.6.15
provides sent/queued responses and paginated event history, but no public spawn/send
idempotency key or Stop veto. Lifecycle listeners announce changes and are not a
replay log. BB0.45.0 idle Stop was measured on a disposable owned thread: no new
history event and no change to public state. A restart cannot infer that pause.

## Options

- Treat SDK send as consumption: loses unread mail when a turn never reads it.
- Retry spawn after an ambiguous reply: can create a second executor.
- Require manual resume for every idle thread: protects invisible idle Stop but
  also disables automatic mailbox wake.
- Retain canonical mail, reconcile bounded hints and provide durable plugin Stop:
  automatic wake remains useful; idle BB Stop has an explicit documented limit.

## Decision

Use the last option. Persist launch intent before SDK spawn and never automatically
relaunch an uncertain participant. Mutable launch markers identify diagnostic
candidates only; authentication still requires the durable and canonical binding.

Register listeners before a recovery service replays sequenced history and scans
canonical unread mail. Persist cursors, wake revision/intent/attempts and a separate
pause epoch in plugin SQLite. Canonical fan-out recovery closes the crash gap before
an outbox entry exists. A known accepted/queued hint is reconciled by marker; an
unobserved ambiguous hint waits 30 seconds before bounded repetition. There are
three attempts per unread revision and two turn-boundary continuations per latest
acknowledged task without a later canonical result/review. Explicit resume resets
those budgets after validating an available idle participant.

Plugin Stop persists pause before SDK Stop. Later SDK replies and stale binding
saves cannot unpause it; dispatch rejects stopped/superseded hints and rechecks
pause after awaited validation. A stopped launch is
orphaned before the initial assignment; recorded intent and workspace are retained.
Initial assignments carry the persisted launch marker independently of SDK send
attribution. Replay is refreshed before outbox creation and after dispatch validation,
including while lifecycle announcements overlap an existing reconciliation.
Arming replays launch history rather than skipping to its latest sequence; interrupted
preparation remains paused. The adapter's preparation Stop follows confirmed idle.
Active BB interruption, rejected/failed turns and denied interactions also pause replay.
Pending interactions, active threads, other queued input and unknown/offline state
do not receive another automatic turn. Legacy bindings remain paused until resume.

## Consequences

SDK delivery, canonical ACK, result, acceptance and environment cleanup remain
different observations. Repeated hints can consume a canonical ID only through
the existing mailbox read contract; this is not exactly-once source-work execution
or a transaction spanning BB and Promptobus. Full role acceptance belongs to the
role workflow, not to finding a later result message.

The owner selected plugin Stop as the guaranteed durable pause. Ordinary BB Stop
on an already-idle thread cannot provide that guarantee through this SDK. Direct
BB Send now overrides admission by design; automatic wake stays paused until plugin
resume. Ambiguous launches require explicit operator inspection and preservation
before cleanup; recovery never claims an unrecorded thread as an authenticated actor.
No native supervisor, warden, guard or worktree owner is added to the BB path.
