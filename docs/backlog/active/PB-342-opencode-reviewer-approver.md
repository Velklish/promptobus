# PB-342 · Reviewer and approver lift through opencode

- **Scope:** [05-drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** PB-341 (worker lift, holder protocol, contract dictionary)
- **Cost:** major
- **Previous order:** 280
- **Taken:** 2026-10-06

## Context

PB-341 lifts workers through a per-participant `serve` holder with `pull` activation; reviewer
and approver lifts are not declared (`approverLift` absent, no reviewer sandbox). A reviewer reads
a report on the bus and edits nothing: the config permission map (`REVIEWER_DENY`) and the MCP
deny surface (`mcpDenyTools`) carry that, plus a follow-up prompt on the same session id as the
wake path.

## Work to do

- Reviewer lift on opencode: read-only config profile, MCP write deny, reviewer prompt rules.
- `approverLift`: approver worktree lift, publication lease path, `eligibleHarnessesForRole` cover.
- Follow-up turns on a live session with a wake probe.
- Docs (05-drivers, CHANGELOG) and tests with fixtures red without the change.

## Out of scope

- Orchestrator/teamlead through opencode — PB-343.
- Changes to claude/cursor/codex drivers.

## Verification

- `npx --no-install backslop gates` green; `npm run probe` on the new checks (commit first).
- Live reviewer and approver lifts through opencode end to end.
