# PB-162 · Under balance the count of live participants per harness bounds the harness choice: a per-harness cap in the overlay

- **Scope:** `lib/model-routing/resolver.js`, `lib/model-routing/validate.js`, `schemas/model-routing/overlay.schema.json`, the model-routing reference page, `test/model-routing-*.test.mjs`
- **Created:** 2026-09-11
- **Dependencies:** none
- **Taken:** 2026-09-11

## Context

Filed from the consumer's card ati-agents BL-552.1 (2026-09-09). The penalties block knows `unknownAvailability`, `liveParticipantPerHarness` and `liveParticipantCap`, but under `balance` the harness is chosen by `pace.effective` inside the band and the penalty only orders candidates within it: a harness whose window is ahead of the others attracts the third and the fourth worker too. Measured 2026-09-06 (BL-552): three workers in a row went to Codex Plus, the five-hour window was exhausted in forty minutes, all three stalled mid-turn, and `near-limit` had no chance to warn — the window record lives sixty seconds in the cache. The consumer holds the rule "no more than two Codex participants at once" in prose (its orchestration skill), which the resolver cannot see.

## Work to do

- Make the number of live participants per harness bound the harness choice under `balance`: a per-harness cap in the overlay (a key such as `caps.liveParticipants.<harness>`, form up to the package) that removes a harness from the band once its live count reaches the cap, or a pace penalty scaled by live participants that enters band selection — one mechanism, per harness, because the three subscriptions have different capacities.
- `spawn` and `review` name the cap when it bounds the choice; `near-limit` stays what it is.
- The reference page and CHANGELOG; tests: two live Codex participants under `balance` with Codex ahead on pace → the third goes to another harness; a cap of zero never chooses the harness; a missing cap keeps today's behaviour.

## Out of scope

- The Codex activity guard and elicitation — PB-41, PB-42 (done).
- The consumer's "no reviewer in Codex" rule — it is about elicitation, not the cap.

## Verification

- Fixtures above green; the consumer's pinned verdict "under balance the live-participant penalty does not reach the harness choice" turns red on the new tag — that is the signal it was waiting for.
- `npm test`, `npx github:Velklish/backslop#v0.4.0 lint`, `npm run audit` green.
