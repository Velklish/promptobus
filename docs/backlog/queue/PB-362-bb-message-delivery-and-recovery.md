# PB-362 · Deliver BB wake hints with durable recovery, bounded continuation and explicit stop handling

- **Scope:** [Protocol](../../reference/04-protocol.md), [CLI warden and guard](../../reference/03-cli.md)
- **Created:** 2026-10-08
- **Dependencies:** [PB-364 · Add a local BB plugin entry point with engine-backed tools and authenticated participants](../../archive/LOG.md#pb-364), [PB-363 · Launch and inspect BB participants with one owner for each environment](PB-363-bb-thread-and-environment-lifecycle.md)
- **Cost:** —
- **Order:** 30

## Context

Canonical typed messages and mailbox ACK belong to Promptobus. BB send can be sent or queued and may wait on an interaction; that response is not mailbox consumption. BB message admission hooks do not provide a native Stop veto, and live event notifications are not a replay log. A runtime adapter must recover pending work without duplicate executors or reviving a participant stopped by the user.

Evidence: Source snapshot `9a2a758209802e0b9632aad958f862d15e2e4c30`: `src/supervisor.ts:478-552`, `lib/guard.js`, `src/v1/engine.ts:101`. BB SDK 0.6.15 `bundled-types/bb-plugin-sdk.d.ts:12609-12904` covers send/queued responses, `:16891` event history, `:21372` HookSignatures (message.dispatch). Public spawn/send types do not expose an idempotencyKey; inspect the exact version before changing retry policy.

## Work to do

- Keep canonical messages/artifacts in the engine and send BB wake references to pending mailbox revisions.
- Persist launch intent, authoritative binding, wake outbox/revision and event cursors. Reconcile ambiguous SDK returns before retrying spawn.
- Allow repeated wake hints with canonical-ID consumption deduplication; do not claim exactly-once delivery across store and SDK.
- Restore state using current thread state and event history after listener registration; handlers must be idempotent across duplicate events and reconnect.
- Replace native Stop-hook enforcement in the BB path with bounded turn-boundary protocol continuation, preserving explicit user stop/archive and denied/pending interactions.
- Document failed/unknown/stopping state handling and operator recovery, including the point where an ambiguous launch needs intervention.

## Out of scope

- No replacement of mailbox ACK with BB send success, unrestricted retry loops or automatic revival after deliberate stop.
- No fabricated public SDK idempotency capability or reuse of the native warden as a second BB lifecycle controller.

## Verification

- Exercise sent, queued, interaction-blocked, duplicate event, duplicate wake, ambiguous spawn/send and plugin/host restart scenarios.
- Canonical message delivery and read ACK remain distinct; reconnect neither loses unread messages nor creates a second executor.
- A stopped/archived participant stays stopped until explicit resume; missing results trigger only the documented bounded continuation.
- Use live BB lifecycle evidence in addition to deterministic crash/replay tests; preserve existing native supervisor/guard regressions.
