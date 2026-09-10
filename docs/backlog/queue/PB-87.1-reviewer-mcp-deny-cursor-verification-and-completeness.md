# PB-87.1 · The reviewer's mechanical MCP write denial covers Claude only: Cursor's deny-pattern syntax for MCP tools is unverified, Codex has no per-tool deny at all, and the host classification carries no completeness signal

- **Order:** 110
- **Scope:** `lib/driver-cursor.js`, `lib/driver-codex.js`, `lib/review.js`, `src/host.ts` (`participantDenyTools`), [03-cli](../../reference/03-cli.md) § Review
- **Created:** 2026-09-10
- **Dependencies:** PB-87

## Context

PB-87 (owner's decision of 2026-09-10, option C) shipped the mechanical layer for the Claude driver: the host classifies its canonical external MCP write tools as `{ server, tool }` pairs, the Claude driver translates them to `mcp__<server>__<tool>` and Claude Code withholds those tools from the reviewer (measured with two headless sessions: a denied id disappears from the tool list; the control offers it and the call reaches the permission engine). The same decision deferred three things:

- Cursor: `.cursor/cli.json` `permissions.deny` is proven only for `Write(**)` and `Shell(**)`; whether it accepts an MCP tool pattern, and in which spelling, needs a live Cursor lift (it spends a Cursor session), so the Cursor reviewer stays prompt-only and says so in its prompt.
- Codex: `prepare()` reads `denyTools` only as a boolean for the sandbox choice; there is no per-tool deny in the launch plan, and closing that gap belongs with the `approvalPolicy` handling (PB-41/PB-42 territory).
- Completeness: `participantDenyTools(role)` returns pairs or `[]`, and the review path treats an empty answer as "nothing to deny" — it cannot tell "this host has no write tools" from "this host has not classified them", so an unclassified server is launched under the prompt-only guard instead of being refused before the launch files are written.

## Work to do

- Codex (owner's decision of 2026-09-10): the mechanical layer is `mcp_servers.<id>.disabled_tools` in the thread config. codex-cli 0.146.0 reads `enabled_tools` and `disabled_tools` on an MCP server entry, and the holder already passes `config.mcp_servers` on `thread/start` (`lib/codex-session.js:1264`). The Codex driver declares `mcpDenyTools`, translates the host's `{ server, tool }` pairs into `disabled_tools` on the matching server entry, and `review` merges them as it does for Claude. Prove it without a paid turn: start app-server under the holder's config, `thread/start`, then `mcpServerStatus/list` — the classified tool is absent from that server's tool list; record the request and reply as a fixture named by version and date.
- Cursor: not verified in this pass — PB-87.2, deferred until the Cursor window is restored. 03-cli keeps Cursor prompt-only.
- Completeness: `participantDenyTools(role)` answers `{ tools, complete }`. `complete: false` — or the member absent on a host that declares canonical external servers — makes `review` refuse before launch files are written when the driver claims the mechanical layer, naming the host and the unclassified servers, the way `denyToolsRefusal` refuses. The standalone host answers `{ tools: [], complete: true }`. No consumer has implemented the member yet (02-host: an obligation before the next pin), so the shape can still change.

## Out of scope

- The Claude layer shipped by PB-87 and the host member's shape for it — a completeness field is an extension, not a replacement.
- The consumer host's own classification list — that is the consumer's change.

## Verification

- A Codex reviewer with a classified write tool: `mcpServerStatus/list` on the thread does not list the tool (fixture, no paid turn); the review prompt says the mechanical layer applies.
- A host answer without completeness for a declared canonical server makes `review` refuse before spawn, with the server named; a complete answer launches.
- `npm test` green.

## Triage — 2026-09-10

- **Track:** L — Spawn, review and command guidance; after PB-88.2, PB-88.1 and PB-116 are on `main` (shared `lib/driver-codex.js`, `lib/codex-session.js`).
- **Priority:** P1 — a reviewer whose write isolation is prompt-only is the gap PB-87 was opened for.
- **Evidence level:** source review at `3ccdf27`: `lib/review.js:65-70`, `src/host.ts:250`, `lib/driver-codex.js:107-110` (`denyTools` read as a boolean); the codex-cli 0.146.0 binary carries the `McpServerConfig` keys `enabled_tools` and `disabled_tools`, and its generated app-server schema lists `mcpServerStatus/list` as a client request (2026-09-10, no session started). Whether app-server honours `disabled_tools` given through the thread config is the one claim the fixture above must prove.
- **Decisions (owner, 2026-09-10):** Codex — `disabled_tools`; Cursor — deferred as PB-87.2; completeness signal — as written.
- **Next step:** implement as the Work to do now reads; isolated review.
