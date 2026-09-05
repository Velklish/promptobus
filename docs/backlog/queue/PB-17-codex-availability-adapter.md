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

## Evidence from the catalog track's inventory (2026-09-05, `codex-cli` 0.146.0)

- `model/list` over `codex app-server --stdio` after `initialize` only (no `thread/start`) answers `{ data: [{ id, model, displayName, description, hidden, supportedReasoningEfforts: [{ reasoningEffort, description }], defaultReasoningEffort, inputModalities, additionalSpeedTiers, serviceTiers, isDefault }] }` — 5 models that day, `gpt-5.6-sol` default. The probe script is kept as a task artifact of the routing run: `.promptobus/tasks/model-routing-v1-in-t20260905-091407/files/codex-model-list-probe.mjs` in the consumer workspace (`node codex-model-list-probe.mjs <checkout> [codex-bin]`, reuses `lib/codex-rpc.js`, `initialize` + `model/list` only).
- app-server writes `ERROR codex_models_manager::cache: failed to load models cache: missing field 'base_instructions'` to stderr and still answers correctly — the adapter must not read that stderr line as a probe failure.

## Contract rules from PB-14 (2026-09-05)

- The adapter contract is `src/model-routing.ts`; `verdictOf` in `lib/model-routing/preflight.js` refuses a verdict whose `state`, `reason` or `source` is outside the closed lists, whose `checkedAt` is unreadable, or whose `reason` is null on a non-available state — and a non-null reason on `available` is a breach too.
- Answer with a verdict, never throw: a thrown error becomes `probe_failed` and its text is discarded (the merged finding PB-14.2 — the verdict `message` is the person's only diagnostic channel). Never put harness output verbatim into `message`.
- `timeoutMs` is the whole preflight budget; do not fill `rated`; report no `windows` where no stable limit source exists; garbled `models`/`windows` elements are dropped by the projection, not repaired.

## Out of scope

- Changing which MCP servers or config the Codex participant gets.
- The stdio MCP prefix question (PB-3).

## Verification

- Adapter tests against the stub app-server the suite already has: limit reached, limit unknown, model missing, timeout.
- Live probe on the owner's machine, recorded in the result, including proof that no thread was started (app-server log or the absence of a session record).
