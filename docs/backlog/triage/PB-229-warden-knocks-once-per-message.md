# PB-229 · The warden knocks once per message, so a four-message hand-off wakes the orchestrator four times

- **Scope:** `lib/warden.js` (the knock), `lib/supervisor.js`, [03-cli](../../reference/03-cli.md) § Guard and warden
- **Created:** 2026-09-17
- **Dependencies:** none

## Context

Run of 2026-09-16, hand-off of worker:t10 at 00:08 UTC (2026-09-17). The hand-off form asks for two records and an evidence file as artifacts, then a `result`: four `promptobus_send` calls within eighteen seconds. The warden knocked four times, one postcard per message, and the orchestrator session was woken four times for one logical delivery; the first `promptobus_mailbox` call would have taken all four.

> Source: `supervisor.log` of task `run-0916-t20260916-130945`: `00:08:35 notification orchestrator: unread 1, knock 1` · `00:08:38 … unread 2, knock 2` · `00:08:40 … unread 3, knock 3` · `00:08:53 … unread 4, knock 4`. Same shape on every hand-off of the run (~40 hand-offs, three idle wake-ups each); each wake-up is a paid turn of the orchestrator with its full session context.

Nothing is lost or duplicated — `unread` counts honestly — the cost is in wake-ups, not in delivery.

## Work to do

- While a knock to an address is outstanding (the postcard sent, the mailbox not yet taken), further messages to that address accumulate under it instead of knocking again; the next knock goes out only after the mailbox was taken, or after a bounded wait.
- The bounded wait is a named constant beside `KNOCK_RETRY_SEC`, with the reason in the reference next to the warden's knock rules.
- `promptobus status` still shows the true `unread` count; the coalesced knocks are visible in `supervisor.log` as one line with the count.

## Out of scope

- The hand-off form itself (records first, then `result`) — it is right that they are separate messages.
- Coalescing across addresses or across tasks.

## Verification

- Supervisor test: four sends to one address within the window → one knock, `unread 4`; after the mailbox is taken a fifth send knocks again. Mutation probe: drop the outstanding-knock check → the test counts four knocks and reddens.
