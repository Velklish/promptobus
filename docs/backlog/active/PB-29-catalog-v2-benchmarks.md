# PB-29 · Catalog v2: live inventories, Cursor-unique families, fable, ratings from public benchmarks

- **Scope:** `models/catalog.json`, `schemas/model-routing/catalog.schema.json`, `lib/model-routing/validate.js`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-23 (the rating rule), PB-28 (efforts and tiers per Codex model)
- **Taken:** 2026-09-06

## Context

The v1 catalog (19 tuples, `source: "initial assessment, routing series, 2026-09-05"`) was rated from model descriptions and the maintainers' judgement. The owner reviewed it on 2026-09-06 and asked for three changes: ratings from **published benchmark results**, Cursor rows only for models **no other harness of the owner serves**, and the missing models added. Live inventories measured that day:

- **Claude Code** (`claude --model`): `claude-opus-5`, `claude-sonnet-5`, and the alias `fable` — Claude Fable 5.1, the top model, absent from the catalog. Effort ladder `low, medium, high, xhigh, max`. The binary also knows `claude-fable-5`, `claude-mythos-5`, `claude-opus-4-8`, `claude-sonnet-4-6`; pin the id the alias resolves to and record how it was verified without a paid turn.
- **Codex** (`model/list`): `gpt-5.6-sol` (default; efforts up to `ultra`), `gpt-5.6-terra` (up to `ultra`), `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`; hidden `gpt-reserve`, `codex-auto-review`. The `fast` service tier exists on all but mini.
- **Cursor** (`cursor-agent models`, 211 ids). Duplicates to drop: every `claude-*` (served by Claude Code) and `gpt-5.6-sol/terra/luna`, `gpt-5.5`, `gpt-5.4-mini` (served by Codex). Unique families to keep, by the owner's choice: `composer-2.5[-fast]`, `cursor-grok-4.6-{low,medium,high,xhigh}[-fast]`, `gemini-3.8-flash-{low,medium,high}`, `gemini-3.7-flash-{low,medium,high}`, `gemini-3.1-pro`, `kimi-k3-{low,high,max}`, `glm-5.2-{high,max}`. Not chosen: `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1`, older Anthropic and Gemini generations, `kimi-k2.7-code`.
- Cursor pools (PB-27): composer and cursor-grok are the `auto` pool; gemini, kimi, glm are the `api` pool. Per-model spend this cycle from `GetAggregatedUsageEvents` (cents): `cursor-grok-4.6-xhigh-fast` 101 240, `gpt-5.6-sol-xhigh` 5 182, `claude-opus-5-thinking-xhigh` 4 880, `cursor-grok-4.6-high-fast` 1 546 — evidence for `quotaCost`, with the caveat that token counts differ by task.

## Work to do

- Rebuild `models/catalog.json` as the inventories say: Claude Code rows for `fable` (pinned id) at `high`, `xhigh`, `max` plus the existing opus and sonnet rows; Codex rows including `ultra` for sol and terra; Cursor rows for the unique families only, each at the effort levels the id encodes (a `-fast` id is the same tuple with a `fast` mark, not a new rating). Roles per row: `reviewer` only where the quality rating reaches the reviewer floor of ADR-004 (5).
- **Ratings by the ADR-004 rule**: for each model, cite in `evidence` the benchmark, the number, the source URL and the date (SWE-bench Verified, Terminal-bench, Aider polyglot, the vendor's model card); map to 1–5 by the rule; effort levels of one model are interpolated from the base row and marked `interpolated` in `evidence`. `speed` and `quotaCost` keep their scales, with evidence where a number exists (Cursor per-model cents, Codex `fast` tier); an assessment with no source says "no published number" and stays a hypothesis.
- `source` field: `"public benchmarks, subscription-balance series, 2026-09-06"`; `assessedAt` today.
- Schema: `evidence` may become structured (`{ text, sources: [{ url, date }] }`) if the ADR asks for it; `validate` refuses a rated row without a source unless it is marked interpolated.
- Produce `docs/reference/…` or the `models` output as a table the approver can hand to the owner: model, harness, effort, quality, speed, quotaCost, roles, sources. **The owner approves the table before the tag** (PB-33).

## Out of scope

- Tuples for the Codex hidden rows.
- Cursor rows for Anthropic or OpenAI models, at any rating.
- Automatic ratings from telemetry (ADR-003, "Not in v1").

## Verification

- `promptobus models validate` green; `npm test` (catalog fixtures updated, the "every tuple's model is in a live inventory" check against the recorded inventories); `npm run audit`; `backslop lint`.
- The approver's table in the result, with every source resolvable.
