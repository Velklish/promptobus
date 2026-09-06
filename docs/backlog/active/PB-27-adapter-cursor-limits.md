# PB-27 · Cursor adapter reads the monthly pools and the included usage from DashboardService

- **Scope:** `lib/model-routing/adapter-cursor.js`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-24
- **Taken:** 2026-09-06

## Context

The Cursor adapter probes `cursor-agent status` and `cursor-agent models` and reports `unknown` / `quota_unknown`: the binary prints no limit. The spike of 2026-09-06 found the calls the Cursor dashboard makes, answered with the CLI's own token:

- **Credentials.** macOS keychain generic passwords `cursor-access-token` (the bearer) and `cursor-refresh-token` (never read); `CURSOR_API_KEY` in the environment is the other way the binary authenticates. `~/.cursor/cli-config.json` has `serverConfigCache.backendUrl` (`https://api2.cursor.sh`) and no secret.
- **Protocol.** Connect over HTTPS: `POST <backendUrl>/aiserver.v1.DashboardService/<Method>`, headers `Authorization: Bearer <token>`, `Content-Type: application/json`, `connect-protocol-version: 1`, body `{}`.
- **`GetCurrentPeriodUsage`** → `{ billingCycleStart, billingCycleEnd (epoch ms as strings), planUsage: { totalSpend, includedSpend, bonusSpend, limit (cents), autoPercentUsed, apiPercentUsed, totalPercentUsed }, enabled, displayMessage, autoBucketModels: [ids…] }`. Two pools in one monthly window: `auto` (Cursor's own models — `autoBucketModels` lists them: composer, cursor-grok, vega) and `api` (named third-party models). Observed 86 % / 98 % / 87 %, `limit` 7000.
- **`GetUsageLimitStatusAndActiveGrants`** → `usageLimitPolicyStatus` and, when present, `thirdPartyUsageNudge { threshold, targetModel, label }` — Cursor's own near-limit signal for the `api` pool. **`GetHardLimit`** → `{ noUsageBasedAllowed }` (PAYG off).
- **`GetAggregatedUsageEvents`** → `aggregations[] { modelIntent, totalCents, tier }` (tier 2 = auto pool, 1 = api pool): evidence for `quotaCost`, not needed at runtime.
- No method returns the plan name; `planUsage.limit` is the tier proxy.

The measured document is in the run's file `spike-limits.md`.

## Work to do

- Read the access token from the keychain (or `CURSOR_API_KEY`); missing → `not_authenticated`; the adapter never reads the refresh token and never writes the token anywhere.
- One `GetCurrentPeriodUsage` call inside the probe budget; two v2 windows, both `{ kind: monthly, lengthSec: (end − start) / 1000, resetAt: end }`: `{ scope: { pool: "auto", models: autoBucketModels }, usedPercent: autoPercentUsed }` and `{ scope: { pool: "api" }, usedPercent: apiPercentUsed }` — the `api` pool carries no list, it is the complement (ADR-004). A tuple whose model is in `autoBucketModels` (exact id, or the id's family prefix — say which) maps to `auto`, everything else to `api`. A pool at or past 100 % is exhausted for its tuples; `displayMessage` is surfaced in the message.
- Tier: `{ name: "included:" + planUsage.limit, source: "derived" }` (the closed list of ADR-004: `credentials | probe | derived | user`); the plan name, when the person wrote it under `account.cursor.plan` in the user overlay (ADR-004, no writer in the tool), is display only.
- `thirdPartyUsageNudge`, when present, becomes a warning on the harness; `GetUsageLimitStatusAndActiveGrants` is optional (skip on timeout, the windows still count).
- `cursor-agent status` and `models` stay as they are (auth and inventory); `no-zdr` flags stay.
- Tests on redacted fixtures: pools, mapping of a composer / grok / gpt / claude id to its pool, exhaustion of one pool only, missing token, HTTP refusal, timeout. A live run is the approver's.

## Out of scope

- Reading the plan name from `cursor.com` (401 with the CLI token) — the one-time question is the answer.
- Any change to how the Cursor driver starts sessions.

## Verification

- `npm test` on fixtures; `npm run audit`; `backslop lint`.
- Approver: `promptobus models --refresh` shows Cursor with two pool windows and the included amount.
