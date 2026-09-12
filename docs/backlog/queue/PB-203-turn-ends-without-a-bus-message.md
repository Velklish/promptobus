# PB-203 · A participant's turn can end without a bus message and nothing notices

- **Order:** 3
- **Scope:** `lib/guard.js` (the end-of-turn verdict), `src/supervisor.ts` (`supervisorRound`, escalation), `lib/status.js` (participant state), `docs/reference/03-cli.md` § Guard and warden
- **Created:** 2026-09-12, from a post-mortem of nine participants that sent no result
- **Dependencies:** none

## Context

Of 254 worker participants across the recorded runs, **9 never sent a `result`**: 5 Codex, 2 Cursor, 2 Claude. It is not a property of one harness, which is how it first looked from the bus alone.

None of them hit a limit, and none was refused by approvals or by the sandbox — checked in the logs of each, not inferred: no `turn_aborted`, no `stream_error`, no reached `rate_limit_reached_type`, `approval_policy` `on-request` with zero approval turns.

What actually happened, one line each:

| participant | verdict | evidence |
|---|---|---|
| Codex | finished its turn cleanly and said nothing | last record is `task_complete`; 211 usage records; zero `promptobus_send` |
| Codex | same | tail `token_count → token_count → task_complete`; zero `promptobus_send` |
| Codex | died mid-turn | 1602 `task_started` against 1601 `task_complete`; last record a reasoning item |
| Codex | went silent 39 s after a successful `status` | 28 records total; send succeeded at `…:20.896Z`, log ends `…:21.417Z` |
| Cursor | did read-only recon and stopped | Read 21, Grep 15, Glob 1, Shell 2; zero `StrReplace`/`Write`; one `status` |
| Cursor | never started | 4 blobs, zero tool calls |
| Claude | died after 6 turns | 35 s window; one `status` sent |
| Claude | died after 2 turns | 5 s window; nothing sent at all |

> Source: 2026-09-12, forensic parse of participant session logs per harness; script `forensic_codex.py` in the session scratchpad. Recount of "no result" from `<workspace>/.promptobus/tasks/*/messages/*.json`.

The mechanism guards the mirror case and not this one. `lib/guard.js` returns the turn when the inbox is **unread** and tells the participant to fetch its messages "and reply in your role" — a promise the verdict does not check, since it is built from the inbox count alone. The supervisor escalates a participant to `SILENT` on the same trigger: unread, not unanswered (`src/supervisor.ts`). A participant that reads its mail, works, ends its turn and sends nothing is invisible to both.

The cost is not theoretical: in each of the four Codex cases the work may well exist in the worktree, and the orchestrator learned nothing and waited.

## Work to do

- Define the missing state: a turn that ends with no outgoing message since the last inbound one. Decide what the mechanism does with it — return the turn the way the unread-inbox guard does, or report it and leave the decision to the orchestrator.
- Separate "ended cleanly, said nothing" from "the session died mid-turn": the first needs a nudge, the second a respawn, and today both look identical from the bus.
- Make the state visible in `status` with its own word, distinct from `SILENT` (unread) and from a stall.
- Fix the guard's promise while the file is open: either the verdict checks that a reply was sent, or the text stops promising it.

## Out of scope

- Reliability of any harness — nothing here asks a participant not to die.
- Retry or respawn policy: what to do about a dead session is a separate decision.
- Counting turns for telemetry — PB-205.

## Checks

- Stand probe, both directions: a participant that ends its turn without sending is caught by the new gate; a participant that sent a message in the same turn is untouched. A gate that fires on both proves nothing.
- The mid-turn death case is distinguished from the clean-and-silent case on recorded logs of the nine, not on a synthetic fixture.
- `status` prints the new state for a stand participant, and the existing `SILENT` test stays green.
- The guard's text and its verdict agree: quote both in the card's result.
