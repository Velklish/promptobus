# PB-42 · A Codex turn is watched by its events: the holder records every app-server notification and server request, status prints the last event and its age, the warden reports a turn silent past a budget, and a failed turn is surfaced

- **Order:** 140
- **Scope:** `lib/codex-session.js` / `lib/codex-hold.js` (the holder's notification handling and the session record), `lib/driver-codex.js` (`inspect`), `lib/status.js`, `lib/warden.js` / `src/supervisor.ts` (the stall predicate), [03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-06, the owner's decision 2026-09-06 (next series, after the consumer's release)
- **Dependencies:** PB-97, PB-49, PB-41, PB-99

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

## Consolidated evidence from PB-39.1

### PB-39.1 · A Codex first turn that fails on its first request lifts as a healthy participant, and the failure reaches nobody

- **Recorded order:** 20
- **Scope:** `lib/codex-session.js` (the `turn/completed` handler, `lastTurn`), `lib/driver-codex.js` (`inspect`), [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Recorded dependencies:** none

### Context

Measured 2026-09-06 08:13 UTC on codex-cli 0.146.0, driving `codex app-server --stdio` directly with a `thread/start` and one `turn/start`. `turn/started` is emitted **before the model is reached**. A turn whose very first API request fails emits `turn/started`, then `turn/completed` two seconds later carrying the error:

```
turn/start        accepted, turn 01a075c7-579e-78b1-963f-bbad4ece9170 in 2 ms
notifications     … thread/status/changed, turn/started, … error, turn/completed
```

and in the rollout `~/.codex/sessions/2026/09/06/rollout-2026-09-06T11-13-07-01a075c7-3f29-7fe1-8796-4bc9e82b9357.jsonl`:

```
event_msg {"type":"task_complete","turn_id":"01a075c7-579e-78b1-963f-bbad4ece9170",
 "last_agent_message":null,"error":{"message":"… invalid_request_error …"},"duration_ms":2156}
```

The holder records that outcome as `lastTurn: { id, status, at }` and nothing reads `status`. `inspect` branches on `record.busy` and `record.state` only, so a participant whose first turn died on the first request is reported by `status` as `is alive (the thread is idle)` with a `stall` of `kind: 'unknown'`, `reason: 'the turn ended'` — the same words as a participant that finished its work correctly.

**This is not a regression from PB-39.** The previous criterion waited for `!state.busy && state.turns > 0`, which a failed turn satisfies just as well, so a failed first turn lifted before the change too. PB-39 makes it easier to reach: `spawn` now returns while the turn is still running and never observes its outcome at all, so the error has no reader anywhere in the path.

The practical shape: an account at its session limit, an effort or model the installed CLI cannot serve, a `thread/start` config the model rejects. The orchestrator sees a lifted worker that will never send anything, and learns it only from silence.

### Work to do

- Decide whether a first turn that ends with an error is a lift failure or a stall, and record the answer in [03-cli](../../reference/03-cli.md). A stall is the more likely answer, since the thread is real and the next turn may succeed — but then `lastTurn.status` must reach `inspect` as a named stall kind rather than `unknown`, so `status` and the warden say the turn failed instead of saying it ended.
- Whatever is chosen, the error text app-server put on `turn/completed` is kept on the record; today only `status` is.

### Out of scope

- The lift criterion itself — PB-39 settled it at `turn/started`.
- The Claude and Cursor drivers.

### Verification

- A fake app-server stream whose first turn emits `turn/started` and then `turn/completed` with an error status: `status` names the failure, and the record carries the message.

### Historical deferral

- **Deferred:** 2026-09-06
- **Reason:** found during the 2026-09-06b series and filed after its last acceptance; the `v0.5.0` tag ships what the series accepted, and a queue with open follow-ups blocks the tag.
- **Return condition:** the `v0.5.0` tag is cut; then this returns to the queue at the head of the next series.

## Triage — 2026-09-07

- **Track:** C — Codex session lifecycle.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including the files named in Scope and the current repository configuration. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Includes all of PB-39.1. Keep the PB-39 lift criterion. Surface later failure as a diagnosed participant outcome. Record method/time and an allowlisted summary only: do not log every raw params object, prompt, credential, or tool payload. Elicitation response behavior belongs to PB-41.
