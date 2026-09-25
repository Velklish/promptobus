# PB-229 · The warden knocks once per message, so a four-message hand-off wakes the orchestrator four times

- **Scope:** `src/supervisor.ts` (the knock, `KNOCK_RETRY_SEC`), `lib/warden.js`, [03-cli](../../reference/03-cli.md) § Guard and warden
- **Created:** 2026-09-17
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 120
- **Taken:** 2026-09-25

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

## Re-triage, 2026-09-23

Checked on `39316bc2` from the repository root. **Cost `major`**: every message after the first in a burst costs one more paid orchestrator turn with the full session context. That is paid in every run, not in one place. PB-243's transcript measurement is evidence for it: 143 of 287 postcards landed within 90 s of the previous one.

- **Stale Scope:** `lib/supervisor.js` does not exist and never did (`git log --all --oneline -- lib/supervisor.js` → exit 0, empty). The knock decision and `KNOCK_RETRY_SEC` live in `src/supervisor.ts`, and `lib/warden.js` runs the loop over `dist/`. The Scope line now names that file.
- The knock is per growth of `unread`: `src/supervisor.ts:496` (`const grew = unread > (was.unread ?? 0)`) and `:540` (`… || grew || moved || …`). `KNOCK_RETRY_SEC` (`:23`, 120) only throttles retries at an unchanged count. The log line is `:574`.
- Nothing coalesces: `grep -n -i "coalesc\|outstanding knock" src/supervisor.ts lib/warden.js` → exit 1.
- The hand-off form asks for four sends: an evidence file, the gate record, the handover record, then `result` (`lib/spawn.js:574`, `:578`, `:580`).
- `KNOCK_RETRY_SEC` is documented in `docs/guides/hooks-and-trust.md:184`, not in 03-cli § Guard and warden. The new constant's reason belongs beside it there, or in both places.
- Not tree-checkable: the `supervisor.log` of the 2026-09-16 run (source named in the card).
- The same knock decision serves PB-236 (a quota-dead session) and PB-66.2 (`minor/`, a malformed ref); a change here should keep their cases in view.
