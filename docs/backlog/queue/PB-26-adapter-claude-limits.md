# PB-26 · Claude Code adapter reads the tier and the remaining limits from the OAuth usage endpoint

- **Order:** 40
- **Scope:** `lib/model-routing/adapter-claude.js`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-24

## Context

Today the Claude adapter reports `unknown` / `quota_unknown`: "no stable source for the remaining limit". The spike of 2026-09-06 found the source Claude Code's own `/usage` command uses, reachable with the credentials the CLI already holds:

- **Credentials.** macOS keychain generic password, service `Claude Code-credentials`, account = the OS user (`security find-generic-password -s "Claude Code-credentials" -w`); on Linux the file `~/.claude/.credentials.json`. The value is JSON: `claudeAiOauth.{ accessToken, refreshToken, expiresAt (ms), scopes[], subscriptionType, rateLimitTier }`. Observed `subscriptionType: "max"`, `rateLimitTier: "default_claude_max_20x"`. The tier is therefore known **offline**.
- **Usage.** `GET https://api.anthropic.com/api/oauth/usage`, headers `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`, `Accept: application/json` → 200 with `limits[]`: rows `{ kind: "session" | "weekly_all" | "weekly_scoped", group, percent, severity, resets_at (ISO), scope: null | { model: { id, display_name }, surface }, is_active }`. The top-level `five_hour` / `seven_day` objects duplicate the session and weekly_all rows (`utilization` = percent used). Other top-level keys with odd names are experiments and are ignored. `extra_usage.is_enabled` says whether pay-as-you-go beyond the plan is on.
- **Profile.** `GET https://api.anthropic.com/api/oauth/profile` → `organization.rate_limit_tier`, `organization.has_extra_usage_enabled`, `account.has_claude_max`. Only needed when the keychain lacks the tier.

The measured document is in the run's file `spike-limits.md`.

## Work to do

- Read the credentials by platform (keychain on macOS through the `security` binary; the credentials file elsewhere); an item that is missing or a token past `expiresAt` → `unknown`, `not_authenticated` or `quota_unknown` per the existing reason codes; the adapter **never refreshes** the token (that rotates the user's credentials under Claude Code) and never writes the token or its hash anywhere.
- One request to `/api/oauth/usage` inside the existing probe budget; map `limits[]` to v2 windows: `session` → `{ kind: session, lengthSec: 18000 }`, `weekly_all` → `{ kind: weekly, lengthSec: 604800 }`, `weekly_scoped` → the same with `scope: { model: <display_name>, models: [<the model ids the driver's alias table resolves it to>] }` — `models` absent when the name does not resolve, and then the window binds nothing (ADR-004); `resetAt` from `resets_at`; `usedPercent` from `percent`. A window at 100 % or a row with `locked_reason` → `exhausted` with the reset. HTTP 401/403 → `not_authenticated`; a timeout → `probe_timeout`.
- Tier: `{ name: rateLimitTier, source: "credentials" }` (the closed list of ADR-004: `credentials | probe | derived | user`), falling back to the profile's `rate_limit_tier` with `source: "probe"` only when the keychain has none.
- Inventory: keep the pinned ids; add `fable` → the pinned id the catalog (PB-29) names for it, so a `fable` row is `rated`.
- Tests on fixtures (redacted copies of the spike shapes): windows, the scoped window, exhaustion, expired token, missing item, HTTP refusals. A live run is the approver's.

## Out of scope

- The Linux credentials path beyond reading the file if present — not measured; say so in the reference.
- Any change to how the Claude driver starts sessions.

## Verification

- `npm test` on fixtures; `npm run audit` (no token-like strings in fixtures); `backslop lint`.
- Approver: `promptobus models --refresh` on the owner's machine shows Claude with the tier and three windows.
