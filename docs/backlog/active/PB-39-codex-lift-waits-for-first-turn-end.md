# PB-39 · The Codex lift is confirmed only when the first turn ends, while the lift prompt tells the participant to keep working in that turn — a worker with a real brief is reaped as not lifted

- **Scope:** `lib/codex-session.js` (`turnWaitMs`, `readyMs`, `waitReady`, the holder's first-turn wait near line 1010), `lib/driver-codex.js`, `lib/spawn.js` (the lift prompt: "list them in your first reply. Then work by them"), [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** none
- **Taken:** 2026-09-06

## Context

Measured 2026-09-06 07:13–07:16 UTC on the owner's machine: `promptobus spawn` (ati-agents CLI 0.71.0 over promptobus 0.4.0) of `worker:bl550` with a real task brief, routed by `balance` to `codex-sol-medium`.

- 07:13:30 `thread/start`; 07:13:32 `turn/started`.
- 07:14:12 the worker sent `status` to the orchestrator through the bus MCP tool (kept in the task journal `history/orchestrator/20260906T071412581-…`): rules read, the plan of the task — alive and working, 40 s into the turn.
- 07:15:32 the holder refused: "the first turn did not end — a thread without a turn does not exist on disk" — `turnWaitMs`, default 120 000 ms; `readyMs = preambleMs + turnWaitMs`. `spawn` exited 1 and reaped the record; 07:16:02 the warden journal: "worker:bl550 GONE: no session record in the Codex registry".

The lift prompt (`lib/spawn.js`) tells every participant "First, read these files and list them in your first reply. Then work by them" and "To wait for a message — just end the turn". A Codex participant reads that as one turn: rules, a status, then the whole task. The driver's readiness needs that turn to END within two minutes. Each rule is right on its own terms, and they cannot both hold for a worker whose brief is a real task; the release canary passes because its brief ends the turn at once.

The env overrides exist (`PROMPTOBUS_CODEX_TURN_MS`, `PROMPTOBUS_CODEX_READY_MS`), and the orchestrator of the 2026-09-06b run used them (turn wait 90 min) as a workaround, not a fix: for the whole first turn the participant has no confirmed session record, so the warden cannot wake it and `status` shows it as not lifted.

## Work to do

- Decide the readiness criterion for Codex, and record it in [03-cli](../../reference/03-cli.md): (a) confirm the lift at `turn/started` with the thread id and make the wake path tolerate a thread whose first turn has not ended — re-measure the premise "a thread without a turn does not exist on disk" against app-server's rollout file; or (b) a two-turn lift protocol for Codex only: the first turn is the rules acknowledgement and ends, the brief goes out as the second turn, and the driver confirms on the first turn's end as today; or (c) raise the default and document the window as a lift budget.
- Whatever is chosen, `promptobus status` names a Codex participant in its first turn as lifting ("first turn, N s") rather than "not in the list" or "GONE".

## Out of scope

- The Claude and Cursor drivers.

## Verification

- A spawn with a brief whose first turn runs longer than two minutes lifts, and a `review` message wakes it afterwards; `npm test` on the ready criterion.
