# PB-285 · Move the Codex driver to the installed codex-cli 0.164.0-alpha.11.1

- **Scope:** `lib/driver-codex.js`, `test/fixtures/codex-app-server/`, [05-drivers § CODEX](../../reference/05-drivers.md#codex--codex-harness-driver--the-third-production-bus-driver)
- **Created:** 2026-09-27
- **Dependencies:** none
- **Previous order:** 160
- **Taken:** 2026-10-28

## Context

The card was written for 0.157.1 on 2026-09-26. Since then the driver moved on: `PROVEN_CODEX_VERSION` is `0.163.0` (`lib/driver-codex.js`) and fixtures exist up to `test/fixtures/codex-app-server/0.163.0/`. Evidence: 2026-10-28, `codex --version` on the owner's machine → `codex-cli 0.164.0-alpha.11.1`. The owner decided on 2026-10-28 to retarget this card to that installed binary, an alpha build, and to take its live measurements now that the Codex limit has reset. The observations on 0.163.0 and earlier remain evidence for those versions only.

## Work to do

- Capture `codex --version` and regenerate the app-server fixtures for 0.164.0-alpha.11.1; raise `PROVEN_CODEX_VERSION` with any version-bound references, and say in 05-drivers that the proven version is an alpha build.
- Run `npm run codex-schema` against the new binary and the repository gates.
- Re-measure live `SessionStart` and `Stop` hooks for a worker, reviewer and approver; record each holder journal after `turn/completed` and identify the hooks file on its events.
- Re-measure the MCP child environment and the Codex approver lift on that binary. Keep commands, exit codes and the observed boundaries with the evidence.
- In a live lift on that binary, name a model returned only by `model/list` with `includeHidden: true` and run a turn; record the result for PB-187.3 (which accepts a measurement on 0.156.1 or later). Capture the full `account/rateLimits/updated` payload in the holder journal for PB-24.1, including whether it carries a window duration. Keep both finding cards in their current directories.

## Out of scope

- Installing or updating the owner's Codex binary in this task.
- Reinterpreting observations on 0.163.0 or earlier as evidence for 0.164.0-alpha.11.1.

## Verification

- `codex --version` names 0.164.0-alpha.11.1; regenerated fixtures and `PROVEN_CODEX_VERSION` agree with it; `npm run codex-schema` and the repository gates exit 0.
- Live holder journals on that binary show `SessionStart` and `Stop` from the intended worker, reviewer and approver hooks files, including `turn/completed`, or record a measured cause for any absent event.
- The MCP child environment and approver lift are captured with commands and exit codes on the same installed binary.
- The named hidden-model turn has a recorded outcome, and the notification payload is captured verbatim with secrets redacted; if the notification does not arrive, record the attempted path and leave PB-24.1's return condition open.
