# PB-41 · A Codex reviewer hangs after the holder answers an `mcpServer/elicitation/request` with a bare allow — the turn never ends and no report arrives

- **Scope:** `lib/codex-hold.js` / `lib/codex-session.js` (the holder's server-request handling), `lib/driver-codex.js`, [03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-06
- **Dependencies:** PB-39 (the lift criterion; this is the turn after it)

## Context

Measured twice on 2026-09-06 with codex-cli 0.146.0, both times a **reviewer** (`review/start`) on `codex-sol-xhigh` whose participant inherits the owner's personal MCP set (~25 servers):

1. The PB-39 live probe (08:48 UTC): the reviewer lifted in 7 s and its report never arrived in the six minutes before the probe task was closed; `status` said `is alive (the turn is running)` throughout.
2. The BL-551 review of the consumer's run (11:26 UTC): holder log — `turn/started` 11:26:49, then `approval allow mcpServer/elicitation/request` at 11:26:58, then **nothing for 35 minutes**; both processes (`codex app-server --stdio` and the holder) at 0.0 % CPU; record `state: starting, busy: true` (a 0.4.0 record, the consumer was still on 0.4.0). Killed by the orchestrator at 12:04.

The worker of the same run (`turn/start`, same MCP set, same account) did not hang. An MCP **elicitation** is a server asking the client for structured input; the holder answers server requests with a blanket allow (the same path as an approval), which is not an elicitation answer, and app-server then waits for content that never comes. Which server elicited is not in the log — the holder does not print the request's params.

## Work to do

- Log the server request's method **and** its server / message when the holder answers it, so the next hang names the server.
- Answer `mcpServer/elicitation/request` correctly: decline it (the participant has no person to ask) rather than allow it, or answer with the shape the protocol expects; measure on app-server which answer lets the turn continue.
- A turn that receives no event for longer than a budget after a server request is reported by `status` as "waiting on a server request since <time>" rather than "the turn is running" — the second case above was indistinguishable from work.

## Out of scope

- Which MCP servers a Codex participant inherits (a consumer's configuration).

## Verification

- A fake app-server that emits an elicitation request: the turn continues (or the request is declined and the turn continues); `status` names a stuck request after the budget; `npm test`.
