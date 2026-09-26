# PB-263 · Minor batch: catalog evidence that no longer matches its sources

- **Scope:** `models/catalog.json` (`codex-terra-max`, `codex-gpt55-medium`, `cursor-grok-high`), [guides/model-routing](../../guides/model-routing.md)
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** minor
- **Previous order:** 320
- **Taken:** 2026-09-26

## Context

Two entries left by the catalog passes PB-246 and PB-254: two Codex rows state as hypotheses figures that the Terminal-Bench 2.1 page carries, and a Cursor Grok row says no list price exists when xAI now lists one. Neither changes a rating or a route; the evidence stops contradicting its own sources.

## Work to do

- [PB-246.2](../minor/PB-246.2-codex-tb21-figures-citable.md) — `codex-terra-max` (78.4 % ±1.3) and `codex-gpt55-medium` (83.1 % ±1.1) cite their Terminal-Bench 2.1 Codex CLI figures as a `quality` source, the way `codex-luna-max` cites the same page, and drop `quality` from `evidence.hypothesis`; bands 7 and 8 unchanged. The `codex-gpt55-medium` speed text stops naming the 90 tokens/s Sol figure the catalog no longer carries; its band 3 stays a hypothesis. The guide's count of base models with a `quality` hypothesis follows.
- [PB-254.1](../minor/PB-254.1-grok-4-6-rows-list-price.md) — the `cursor-grok-high` evidence stops saying no list price exists: xAI lists grok-4.6 at $2.00 in / $6.00 out below 200k prompt tokens; whether Cursor's `cursor-grok-4.6` is that model is not established, so no price is attached and `quotaCost` 10 stays a hypothesis from the local usage spike. The guide's sentence on the Grok 4.6 rows follows.

## Out of scope

- Any rating, band, anchor pair or routing change, and the `-fast` ids.
- Re-placing the `codex-gpt55-medium` speed band — a rating decision this batch does not take.
- PB-13.2 (no pay-as-you-go row) — its trigger is a future row, not this pass.

## Verification

- The diff of `models/catalog.json` touches no `ratings`, `priority`, `billing` or `prices` field; `models validate` and the model-routing suites pass on the changed catalog.
- Each entry is closed with `archive N.k --into 263` and one outcome line in this card's `result.md`; gates green.
