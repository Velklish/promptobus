# PB-42 · A Codex turn is watched by its events: the holder records every app-server notification and server request, status prints the last event and its age, the warden reports a turn silent past a budget, and a failed turn is surfaced

- **Order:** 5
- **Scope:** `lib/codex-session.js` / `lib/codex-hold.js` (the holder's notification handling and the session record), `lib/driver-codex.js` (`inspect`), `lib/status.js`, `lib/warden.js` / `src/supervisor.ts` (the stall predicate), [03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-06, the owner's decision 2026-09-06 (next series, after the consumer's release)
- **Dependencies:** PB-41 (the elicitation answer), PB-39.1 (the failed first turn)

## Context

The 2026-09-06b run showed that a Codex participant cannot be watched today. `status` prints `is alive (the turn is running)` for the whole turn, and a turn that has hung (PB-41: three reviewers in a row, each silent after `approval allow mcpServer/elicitation/request`, both processes at 0.0 % CPU for 35 minutes) is indistinguishable from one that is working. The Cursor driver judges a stall by silence of the transcript plus the absence of tool children; for Codex the same class was closed by `busy` / `ThreadStatus`, which means a running turn is never reported — and a hung turn is a running turn. The holder's log carries turn-level events, approvals and stderr only; app-server also emits `item/started`, `item/completed`, `item/commandExecution/outputDelta`, `item/agentMessage/delta`, `serverRequest/resolved`, `thread/tokenUsage/updated` — an activity stream nobody records. A turn that ended `failed` (subscription exhausted) is written to `lastTurn.status` and read by no one (PB-39.1). The orchestrator found each of these by hand: `tail` of the holder log, `ps` on the pids, the record's json.

## Work to do

- The holder records every app-server notification's method (and, for server requests, the method, the server and a one-line summary of the params) with a timestamp in its log, and keeps `lastEventAt` / `lastEvent` in the session record.
- `inspect` / `status` print, for a running turn, the last event and its age: `is alive (the turn is running · last event item/commandExecution/outputDelta 4 s ago)`.
- The warden's stall predicate for Codex: a running turn with no event for longer than a budget (the Cursor watchdog's 180 s is the starting point) and no pending server request is reported as `молчит N с`; a pending server request is reported as `ждёт ответа на <method> от <server> с <time>` — both are visible, neither is "the turn is running".
- A turn that ends `failed` is reported with its error text in `status` and in the warden's journal (PB-39.1 folds in here or stays its own).
- Reference § The Codex holder: what is recorded, what the budget is, what each line means.

## Out of scope

- The elicitation answer itself — PB-41.
- Which MCP servers a participant inherits.

## Verification

- A fake app-server that starts a turn and goes silent: after the budget `status` says silent, the warden journal says silent; a stream with a pending server request names it; a failed turn names its error; `npm test`.
