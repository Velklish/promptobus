# PB-41.1 · Live Codex reviewer still hangs after elicitation decline — app-server says request not found

- **Scope:** `lib/codex-session.js` (holder `mcpServer/elicitation/request` decline), [03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-08
- **Dependencies:** PB-41

## Context

PB-41 changed the holder to decline `mcpServer/elicitation/request` with `{ action: "decline" }` so the turn can continue. The stub suite covers that. A live Codex reviewer on 2026-09-08 still produced no bus `result`.

Measured on codex-cli 0.146.0, `promptobus review --harness codex --effort xhigh --permission-mode read-only`, isolated `PROMPTOBUS_CODEX_HOME`, no edit of `~/.codex/config.toml` (sha unchanged). Holder log `/private/tmp/promptobus-codex-run/worker-evidence/live-reviewer-holder-54352.log`:

- `13:39:07.004Z` `thread/start … reasoningEffort=xhigh`
- `13:39:08.910Z` `event turn/started` then `alive` — lift returned in 5.9 s
- `13:39:26.655Z` `approval deny mcpServer/elicitation/request … server=promptobus-promptobus mode=form`
- `13:39:26.659Z` app-server stderr: `failed to resolve elicitation request in session` / `elicitation request not found`
- No further holder events for the remaining ~300 s wait. No `turn/completed`. Orchestrator inbox: no `result` from `reviewer:cargos-api`.

The same account's worker smoke the same hour (`turn/start`, same isolation) sent a status and a follow-up wake result (11/11). The hang is still reviewer-shaped, as in PB-41's original live measurements, now with a decline instead of a bare allow.

## Work to do

- Holder code: both roles use `turn/start` (landed). Keep reviewer role, read-only sandbox, and effort.
- Remaining: one live reviewer fixture on a fully awake host until a `result` arrives from the reviewer address. Overnight fixture waits that crossed host sleep are not acceptance evidence. `{ action: "decline", content: null }` stayed a hypothesis.

## Out of scope

- Worker `turn/start` (already live-green on this account).
- Personal MCP set isolation (still out of scope of PB-41).
- Host power settings and personal `~/.codex/config.toml`.

## Verification

- Holder log after the decline does not contain `elicitation request not found`.
- Live reviewer fixture: orchestrator receives `type=result` from the reviewer address; tree stays read-only.
