# PB-285 · Move the Codex driver to codex-cli 0.157.1

- **Order:** 190
- **Scope:** `lib/driver-codex.js`, `test/fixtures/codex-app-server/`, [05-drivers § CODEX](../../reference/05-drivers.md#codex--codex-harness-driver--the-third-production-bus-driver)
- **Created:** 2026-09-27
- **Dependencies:** none

## Context

On 2026-09-26 the owner reported `npm view @openai/codex version` as `0.157.1`, while the installed Homebrew cask answered `codex-cli 0.156.1`. The driver still sets `PROVEN_CODEX_VERSION` to `0.156.1`, and the checked app-server fixtures live under `test/fixtures/codex-app-server/0.156.1/`. The live Stop-hook observation on 0.156.1 remains evidence for that version only. The owner will install 0.157.1 after the current run.

## Work to do

- Capture `codex --version` after the owner installs 0.157.1, regenerate the app-server fixtures, and raise `PROVEN_CODEX_VERSION` with any version-bound references.
- Run `npm run codex-schema` against the new binary and the repository gates.
- Re-measure live `SessionStart` and `Stop` hooks for a worker, reviewer and approver; record each holder journal after `turn/completed` and identify the hooks file on its events.
- Re-measure the MCP child environment and the Codex approver lift on 0.157.1. Keep commands, exit codes and the observed boundaries with the evidence.
- In a live lift on 0.157.1, name a model returned only by `model/list` with `includeHidden: true` and run a turn; record the result for PB-187.3 (which accepts a measurement on 0.156.1 or later). Capture the full `account/rateLimits/updated` payload in the holder journal for PB-24.1, including whether it carries a window duration. Keep both finding cards in their current directories.

## Out of scope

- Installing or updating the owner's Codex binary in this task.
- Reinterpreting the 0.156.1 observations as evidence for 0.157.1.

## Verification

- `codex --version` names 0.157.1; regenerated fixtures and `PROVEN_CODEX_VERSION` agree with it; `npm run codex-schema` and the repository gates exit 0.
- Live holder journals on 0.157.1 show `SessionStart` and `Stop` from the intended worker, reviewer and approver hooks files, including `turn/completed`, or record a measured cause for any absent event.
- The MCP child environment and approver lift are captured with commands and exit codes on the same installed binary.
- The named hidden-model turn has a recorded outcome, and the notification payload is captured verbatim with secrets redacted; if the notification does not arrive, record the attempted path and leave PB-24.1's return condition open.
