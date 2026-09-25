# PB-255 · Minor batch: Codex 0.156.1 facts — the requestUserInput reply, rollout turn timing, the GPT-5.6 and GPT-5.5 low rungs

- **Scope:** `lib/codex-session.js`, `lib/model-routing/telemetry.js`, `models/catalog.json`, [05-drivers](../../reference/05-drivers.md), [guides/model-routing](../../guides/model-routing.md)
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** minor
- **Previous order:** 290
- **Taken:** 2026-09-26

## Context

Three minor entries in which the code or the catalog has not caught up with what codex-cli 0.156.1 answers. Each one is measured against the installed binary, so the batch goes to a Codex worker, which runs that binary itself.

## Work to do

- [PB-196.2](../minor/PB-196.2-request-user-input-reply-shape.md) — the holder answers `item/tool/requestUserInput` with `{response}`, while the 0.156.1 schema requires `answers` (`lib/codex-session.js:406`).
- [PB-196.3](../minor/PB-196.3-codex-rollout-carries-turn-timing.md) — 0.156.1 rollouts carry `duration_ms` and `time_to_first_token_ms`; establish whether they give a usable throughput observation.
- [PB-246.3](../minor/PB-246.3-codex-gpt56-ladders-lack-low-rung.md) — the gpt-5.6-* and gpt-5.5 ladders carry no low rung, and the luna rows no xhigh, although the 0.156.1 listing offers them.

## Out of scope

- The GPT-6 rows and every non-Codex row of the catalog; the parts of `lib/codex-session.js` PB-185 changes.

## Verification

- Each entry's own evidence re-measured on codex-cli 0.156.1, closed with `archive N.k --into 255` and one outcome line per entry in this card's `result.md`; gates green.
