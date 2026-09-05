# PB-17 · Codex availability adapter: rate-limit and model/list preflight without a turn

- **Order:** 70
- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-14

## Context

The Codex driver already gates a start on the limit: `lib/codex-session.js` waits for `account/rateLimits/updated` (line 821), refuses when `rateLimitReached` (line 826) and checks the model against `model/list` (lines 834–842) — but only inside the start path, after the app-server thread is being set up. The plan wants the same checks as a reusable preflight that opens app-server, reads the notification and the model list, and closes without `thread/start`, then publishes normalised limit windows and models to the snapshot. The refusal in the start path stays: preflight and start are two gates, not one.

## Work to do

- Extract the wait-for-rateLimits and `model/list` calls into an adapter function that runs against a fresh app-server process with the same isolated config the driver already uses, and exits without a turn.
- Normalise windows: `usedPercent`, window length, `resetAt` when the notification gives it; `exhausted` when `rateLimitReached`, with `resetAt` for the cache TTL.
- Keep the start-path refusal unchanged; the adapter and the start path share the classification code, not copies.
- Timeouts: the adapter respects the preflight budget and reports `probe_timeout` rather than hanging on a missing notification (the driver already treats "no notification" as "not a refusal", line 824 — keep that meaning: `unknown` / `quota_unknown`).

## Out of scope

- Changing which MCP servers or config the Codex participant gets.
- The stdio MCP prefix question (PB-3).

## Verification

- Adapter tests against the stub app-server the suite already has: limit reached, limit unknown, model missing, timeout.
- Live probe on the owner's machine, recorded in the result, including proof that no thread was started (app-server log or the absence of a session record).
