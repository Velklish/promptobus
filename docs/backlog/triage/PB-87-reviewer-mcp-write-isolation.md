# PB-87 · driver-claude.js's denyTools already reaches MCP tool ids mechanically, but review.js never classifies which MCP tools are write tools, so the reviewer's read-only guarantee over the canonical server set rests on one prompt paragraph for every harness — including Codex, where denyTools has no effect on MCP calls at all

- **Scope:** [reference/03-cli](../../reference/03-cli.md) § Review ("The reviewer is read-only"), `lib/review.js`, `lib/driver-claude.js`, `lib/driver-cursor.js`, `lib/driver-codex.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`lib/review.js:1069` is the reviewer prompt's only guard against MCP write calls: 'MCP tools of external systems are read-only, and you hold that, not the mechanism. ... nobody will ask you for permission, and there is no person behind the session who would refuse.' The block comment above it (`lib/review.js:32-44`) scopes the mechanism's actual guarantee narrower: 'Isolation is from the context of the session that wrote the code, not from the code: access to the working copy is read-only, and the driver stripping tools is what holds that' — file edits and Bash, not MCP. `docs/reference/03-cli.md:43` states the same narrow guarantee: 'The reviewer is read-only. A harness that cannot deny tools must fail before spawn (`src/driver.ts` `denyTools`).'

Each driver's `REVIEWER_DENY`, re-checked now, lists only built-in tools: `['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']` for Claude (`lib/driver-claude.js:216`), `['Write(**)', 'Shell(**)']` for Cursor (`lib/driver-cursor.js:190`), `['workspace-write']` for Codex (`lib/driver-codex.js:47`). No MCP tool id (`mcp__<server>__<tool>`) appears in any of the three, while the reviewer's settings enable the whole canonical MCP set (`enableAllProjectMcpServers: true`, `lib/driver-claude.js:713`).

`settingsFile()` in `lib/driver-claude.js:710-717` spreads `denyTools` verbatim into `permissions.deny`, and Claude Code's permission engine accepts exact MCP tool ids there — so a per-server write-tool classification merged into `denyTools` before `driver.prepare` would mechanically close the gap for the Claude driver with no driver change. `cliConfig()` in `lib/driver-cursor.js:328-330` likewise spreads `denyTools` into `.cursor/cli.json`'s `permissions.deny` — plausible the same way, but unverified whether `cursor-agent`'s pattern matcher recognizes MCP tool name strings; only a live Cursor lift settles it.

For Codex the same fix has no effect: `prepare()` in `lib/driver-codex.js:92` only reads `!!denyTools?.length` to choose the sandbox (`'read-only'` vs `'workspace-write'`) — the array's CONTENT is discarded. Codex's sandbox governs filesystem/exec, not MCP tool calls, which go through `approvalPolicy: 'on-request'` (`lib/driver-codex.js:100`) instead — a mechanism already flagged broken for approvals in `docs/backlog/queue/PB-41-codex-reviewer-hangs-after-elicitation-allow.md` (a bare `allow` answered to an `mcpServer/elicitation/request`, not a classified decision) and watched by `docs/backlog/queue/PB-42-codex-activity-watchdog.md`. So 'nobody will ask you for permission', for Codex, is an artifact of a blanket auto-approve rather than a designed guarantee.

No ADR or comment documents the MCP-write gap as deliberate, and no backlog or archive entry tracks it (grepped for reviewer+write/isolation/mcp, denyTools+mcp — no hits besides PB-41/PB-42, which are about Codex approval hangs, not this decision).

## Work to do

- Extend the host contract with a per-server write-tool classification the host answers (e.g. `participantDenyTools(role)` on `src/host.ts`, alongside the existing `participantServers()`); ati-agents' `cli/lib/promptobus/ati-host.js` answers it for the canonical set.
- In `lib/review.js`, merge the classified tool names — translated to each driver's own spelling via the existing `toolName()` in `lib/spawn.js` — into `denyTools` before `driver.prepare`, alongside the built-in names already there.
- Ship and verify this first for the Claude driver, where `permissions.deny` is already proven to accept MCP tool ids.
- Before claiming Cursor coverage, do a live Cursor lift confirming `.cursor/cli.json`'s `permissions.deny` recognizes MCP tool name patterns.
- For Codex, do not fold it into this fix — `denyTools`'s array content is unused by `prepare()`, and closing the gap needs a Codex-specific change to `approvalPolicy` handling, adjacent to PB-41/PB-42. Keep the prompt paragraph (`lib/review.js:1069`) as the explicit, sole guard for Codex reviewers and say so in the prompt text.
- Update `docs/reference/03-cli.md`'s reviewer paragraph (line 43) to describe the two-layer guarantee once shipped: mechanical denial of MCP write tools for Claude (and Cursor if verified), prompt-only for Codex.

## Out of scope

- Redesigning Codex's `approvalPolicy` handling — that belongs with PB-41/PB-42, not this entry.
- Classifying every individual MCP tool on every canonical server up front — start with the servers the reviewer prompt already names and extend as gaps surface.

## Verification

- A live Claude reviewer session attempts a canonical write call (e.g. `mcp__ati-kaiten-mcp__create_card`) after the fix and is refused by Claude Code's own permission engine, not merely instructed not to by the prompt.
- A new test asserts the merged `denyTools` passed to `driver.prepare` for a Claude reviewer includes the classified MCP tool ids.
- `npm test` green; the reviewer prompt for Codex still states plainly that MCP write isolation there rests on the model following instructions, not a mechanical gate.
