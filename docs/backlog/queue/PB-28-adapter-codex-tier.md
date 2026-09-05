# PB-28 · Codex adapter reads the plan, credits and hidden rows; ultra effort and the fast tier in the inventory

- **Order:** 60
- **Scope:** `lib/model-routing/adapter-codex.js`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-24

## Context

The Codex adapter already reads `account/rateLimits/read` into two windows (primary 5 h, secondary 7 d) and drops hidden rows of `model/list`. The spike of 2026-09-06 (`codex-cli 0.146.0`) measured what it leaves on the table:

- `account/read` → `{ account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth }`; `account/rateLimits/read` also carries `planType`, `credits { hasCredits, unlimited, balance }`, `spendControlReached`, `rateLimitReachedType`, and `rateLimitResetCredits { availableCount, credits[] { resetType, status, title, grantedAt, expiresAt } }` — the account holds two "Full reset (Weekly + 5 hr)" credits the person may spend by hand.
- `model/list` rows carry `hidden` (true for `gpt-reserve` and `codex-auto-review`), `supportedReasoningEfforts` (sol and terra include `ultra` above `max`), `additionalSpeedTiers: ["fast"]` and `serviceTiers` ("1.5x speed, increased usage") and `isDefault`. There is no "astra" model on this account.

## Work to do

- Tier: `{ name: planType, source: "account/read" }` (or from the rate-limits answer when `account/read` refuses).
- Windows gain `kind` (`session` for primary, `weekly` for secondary) per PB-24; `resetsAt` is epoch **seconds** — keep the existing conversion.
- Informational fields into the harness record: `credits`, `spendControlReached`, `resetCredits.availableCount`; `models` text prints the reset-credit count as a note. The adapter never spends a reset credit.
- Inventory: keep hidden rows with `hidden: true` instead of dropping them (the resolver's `model-not-in-inventory` treats hidden as not offered; `models validate` can then say "hidden" rather than "missing"); record per model its efforts and speed tiers so the catalog (PB-29) can rate `ultra` rows and `quotaCost` can name the `fast` tier.
- Tests on fixtures; a live run is the approver's.

## Out of scope

- Any change to the Codex driver, `thread/start` or the MCP prefix.
- `ultra` as a spawn `--effort` value — the driver's `EFFORT_LEVELS` is a separate decision; the inventory only records that the model lists it.

## Verification

- `npm test` on fixtures (hidden rows, `ultra`, reset credits, `planType`); `npm run audit`; `backslop lint`.
- Approver: `promptobus models --refresh` shows Codex with the plan and the two kinds.
