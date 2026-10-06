# PB-343 · Orchestrator and teamlead sessions through opencode

- **Order:** 290
- **Scope:** [05-drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** PB-341 (worker lift), PB-342 (reviewer, approver)
- **Cost:** major

## Context

Worker, reviewer and approver lifts cover tracks; the run itself is still led from another
harness (teamlead lifts only on claude/codex today). Closing the loop means orchestrator and
teamlead sessions through opencode, plus the consumer side: the workspace mechanism's parity
record and the dependency re-pin onto the release carrying the driver.

## Work to do

- Teamlead/orchestrator lift on opencode (lead prompt, owner binding, contact points).
- Consumer re-pin: tag the promptobus release carrying PB-341–PB-343, move the mechanism pin,
  update the parity record.
- Docs (05-drivers, CHANGELOG) and tests with fixtures red without the change.

## Out of scope

- npm publication of the package.
- Changes to claude/cursor/codex drivers.

## Verification

- `npx --no-install backslop gates` green; `npm run probe` on the new checks (commit first).
- A live run led through opencode end to end.
