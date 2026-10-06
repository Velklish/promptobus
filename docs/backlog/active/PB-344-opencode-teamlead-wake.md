# PB-344 · Wake the opencode teamlead: hand over the contact point

- **Scope:** [05-drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** PB-341 (holder lift), PB-342 (wake path), PB-343 (teamlead lift)
- **Cost:** major
- **Taken:** 2026-10-06

## Context

Waking the teamlead is the run's heartbeat: a deaf teamlead never takes its mail. Code reading found the opencode contact-point handover broken in three places at once: the teamlead prepare call passes no home (worker path does), the holder record carries no home/task/address (the MCP identity check never matches, teamlead sends are refused — the PB-343.2 transcript), and `registerWake` demands a session argument the only in-protocol caller never passes. Owner constraint: no behavior change for Claude/Cursor/Codex.

## Work to do

- Pass `home` into `driver.prepare` on the teamlead path.
- Carry home/task/address in the opencode holder record.
- Let opencode `registerWake` fall back to the record's session id when the caller names none.
- Accept the warden-shaped `{socket, token}` target in opencode `activate` (found live: the string-only read missed every warden knock).
- Tests pinning each break (red before, green after), docs (05-drivers) and CHANGELOG in the same pass.

## Out of scope

- Loop-guard hook on the holder (PB-343.1 stays open).
- Wake-in to the orchestrator's own opencode session (other direction).
- Managed-root `lead` (stays Codex-only).
- Any change to claude/cursor/codex drivers.

## Verification

- `npx --no-install backslop gates` green; `npm run probe` on the new checks (commit first).
- Live teamlead lift on a scratch root: contact point handed over, status/result delivered, idle wake taken.
