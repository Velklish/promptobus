# PB-233 · A second task lifted from a bound session leaves its orchestrator without a contact point: the warden knocks 0 and the loop guard watches only the bound task

- **Order:** 
- **Scope:** `lib/warden.js` (contact point of `orchestrator`), `lib/review.js` (task creation from a bound session), `lib/guard.js` (`boundTaskId`), the bus hook template that hands the session socket over, [03-cli](../../reference/03-cli.md) § the warden
- **Created:** 2026-09-17, consumer run
- **Dependencies:** none

## Context

A Claude Code session that runs an orchestration (its binding: task A) lifted a solo review of its own commits with `promptobus review <clone> --base … --title …`. That created task B with the same session as `orchestrator`. The reviewer's `result` landed in task B's mailbox and nobody woke the session; the person noticed and asked.

Measured 2026-09-17, tasks `run-0917b-t20260917-074114` (A) and `bl-692-pin-promptobus-v0-t20260917-090617` (B), CLI 0.81.0 on promptobus 0.11.0, Claude Code 2.1.263:

- `promptobus status --task B`: `orchestrator · owner 04e18ed2-… · unread 0 · alarm: self-wake (reason: no contact point — the participant did not hand over a socket) — starting up; clears on the first knock`.
- warden journal of B: `delivered orchestrator: mailbox was taken (had 1, knocks 0)` — zero knocks; the mailbox was emptied by the session's own `promptobus_mailbox {task: B}` after the person asked.
- The same session in task A is knocked normally (every message of the run reached it as a postcard).
- The loop guard (`guard.js:178`, `:411`) resolves the task to guard as `identity.declaredTask ?? boundTaskId(...)` — task A — so an unread message in B does not return the turn either.

So the two wake channels both key on the session's ONE binding: the socket is handed over for the bound task, and a task the same session lifts later has an `orchestrator` record with no contact point. The skill text «self-wake at task creation clears on the first knock» is true only when a knock can happen; here none can.

## Work to do

- Make the contact point follow the session, not the task: a session that already handed over a socket for one task gives the same socket to every task it is `orchestrator` of (at `review`/`spawn` time, or the warden of the new task reads it from the bound task's record).
- Make the loop guard count unread across every active task whose `orchestrator` is this session, not only the bound one — or state in the guard text that the other tasks are not watched and name them.
- Say in 03-cli § the warden what a second task of a bound session gets today.

## Out of scope

- Multiple bindings per session (one binding stays).

## Verification

- A session bound to task A lifts a review that creates task B; a `result` sent to B's `orchestrator` produces a knock in B's warden journal (`knocks 1`), and `status --task B` shows no `self-wake` for the orchestrator.
- With the knock channel disabled, the loop guard returns the turn on an unread message in B.
