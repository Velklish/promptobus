# PB-160 · Codex participant is told hyphenated MCP tool names, but Codex exposes them sanitized to underscores — every call by the told name fails in 0 ms

- **Scope:** `lib/driver-codex.js` (`mcpToolName`), `lib/codex-session.js` (`codexMcpName`), participant order text; consumer ati-agents BL-517.2
- **Created:** 2026-09-10
- **Dependencies:** none

## Context

Found by the consumer (ati-agents, `BL-517.2`) on a live `live-codex.mjs` run, 2026-09-10 12:52 UTC, codex-cli 0.146.0, promptobus v0.5.1, model `gpt-5.6-sol`, sandbox read-only.

The participant order text names the bus tools by `mcpToolName(server, name, prefix)` → `mcp__ati-agents-promptobus__promptobus_send` (the override key `ati-agents-promptobus` glued verbatim). Codex itself lists the same tools **sanitized**: the rollout of thread `01a08b5f-f340-7e90-9c37-1e0ceed0df64` shows `ALL_TOOLS` containing `mcp__ati_agents_promptobus__promptobus_mailbox`, `…__promptobus_send`, `…__promptobus_task` (hyphens → underscores). The same happens to the consumer's memory section: `mcp__ati-agents-context-store__search_facts` is told, `mcp__ati_agents_context_store__…` exists.

Codex calls tools through its `exec` JS harness (`tools.<name>(...)`). A name with hyphens is not even a valid property: `tools.mcp__ati-agents-promptobus__promptobus_send({...})` parses as a subtraction and throws before any server is reached — which is exactly the shape of the original finding: four calls in a row `status: failed`, `durationMs: 0`, no error text, then five minutes of CLI workarounds (`BL-517.2`). Today's run passed 11/11 only because the model did not trust the order: it filtered `ALL_TOOLS` by "promptobus" first and called the sanitized names — `promptobus_mailbox` Ok in 2 ms, `promptobus_send` Ok in 5 ms, `LIVE-CODEX-HELLO` delivered in 50 s.

Name forms in that transcript: told form ×14 (prompt), listed/called form ×8 (tools list and calls). The rule Codex applies, as measured: every character outside `[A-Za-z0-9_]` in the server key becomes `_`.

## Work to do

- `mcpToolName` for the Codex harness renders the name the way Codex exposes it: server key sanitized (`[^A-Za-z0-9_]` → `_`), then `mcp__<key>__<tool>`. One function, as today, so the order text, the wake text (`orderBody`) and the consumer host (`toolName(server, name)` in the ATI host memory section) all follow.
- A verdict in the suite: the told name for a key with a hyphen (the consumer prefix is `ati-agents-`) equals the sanitized form; a mutation back to the raw key must go red.
- The holder surfaces an MCP call failure as an event with a reason (today: `failed`, 0 ms, no text — undistinguishable from a dead server), so a live stand can stop with a diagnosis instead of waiting out the 300 s ceiling.

## Out of scope

- The Cursor and Claude tool-name forms (`server-name`, bare name) — unaffected.
- The consumer's live stand asserting told ⊆ listed names: it would have to read `~/.codex/sessions`, which the stand deliberately does not.

## Verification

- `node cli/scripts/live-codex.mjs` in the consumer delivers `LIVE-CODEX-HELLO` by the told name (transcript: the first `exec` call uses the name from the order, no `ALL_TOOLS` lookup).
- `npm test` green; the new verdict red on the raw-key mutation.
- A stubbed MCP failure reaches the holder log with a reason before the wait ceiling.
