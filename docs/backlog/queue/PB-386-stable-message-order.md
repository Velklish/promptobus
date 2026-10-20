# PB-386 · Canonical message order must survive wall-clock rollback

- **Order:** 330
- **Scope:** [Protocol and storage](../../reference/04-protocol.md), canonical message ordering and current-result selection
- **Created:** 2026-10-20
- **Dependencies:** none
- **Cost:** major

## Context

At source `5386bd5d6dedd84dd69760cfee4f1c0f19543f87`, a deterministic engine fixture sent two results, moving the injected wall clock backwards by one second before the second send. Mailbox order was second-result then first-result; choosing the latest message by ID selected the earlier send. This demonstrates ordering under a controlled clock rollback, not the occurrence of such a rollback in a previous run.

Evidence: the existing message-ID generation and mailbox ID sort in `src/v1/messages.ts`, plus the audit diagnostic's `clock-order` observation (exit 0). The audit sidecar preserves actual send IDs, observed mailbox order and source provenance. Source review also found semantic consumers: `bb-plugin-promptobus/engine-host.ts` selects the latest assignment and compares result IDs for pending obligations; `lib/review.js` selects retained reviewer findings by ID and checks result freshness by wall-clock timestamps. Those consumer consequences are code-derived, not executed by the diagnostic.

Priority: before acceptance logic relies on latest-result selection. Impact: stale result selection or misleading delivery cursors; live frequency, duration and token cost are notMeasured.

## Work to do

- Define durable canonical ordering independently of wall-clock movement, using the current task/store transaction boundary.
- Make mailbox history and consumers selecting the current result use that order. Keep wall-clock timestamps for display and measurement.
- Specify compatibility with retained messages; do not rewrite immutable old evidence merely to change sorting.

## Out of scope

- A new distributed clock service, global scheduler or arbitrary sleeps.
- Treating all timestamp sorting as defective where chronological display is the actual contract.

## Verification

- Inject equal timestamps, backward clock movement and multiple senders; current-result selection follows committed order deterministically.
- Reopen the engine and replay retained history; ordering and deduplication remain stable.
- Verify compatibility with existing message IDs and BB delivery cursors, including equal-time and restart boundaries.
- Exercise BB pending obligations, step-result freshness and dead-reviewer findings selection under rollback. Fixing ID generation alone is insufficient if timestamp comparisons retain the same semantic problem.
- Keep the original rollback observation and the corrected behavior separately.
