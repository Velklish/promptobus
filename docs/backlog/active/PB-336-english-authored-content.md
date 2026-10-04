# PB-336 · Apply the English authoring rule to all project-owned content

- **Scope:** [Contributing](../../guides/contributing.md)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 60
- **Taken:** 2026-10-04

## Context

At `6f4e9a3`, repository policy applies the English authoring rule to only part of the project: `docs/guides/contributing.md:32` permits README.ru.md and exempts scripts/tests. `package.json:17` publishes the Russian README. `scripts/live-mixed.mjs:214-223,328,381` authors Russian review instructions and routine commit/scenario text; `scripts/live-codex.mjs:121`, `scripts/live-cursor.mjs:173,427-429` and `test/scenario.mjs:350,524,649,738,911` do likewise. `scripts/audit-public.mjs:35,138-145` checks only runtime directories.

A Cyrillic match alone is not a defect: intentional multilingual inputs, captured evidence and the TRANSLIT table also contain Cyrillic. PB-317.1 requests another change to the translation surface and must be reconciled with this owner-directed policy.

## Work to do

- Make project-owned explanations, comments, ordinary scenario narration and prompts English across scripts, tests, docs and consumer output.
- Reconcile README.ru.md, its links and packaging with English-only delivery; account for PB-317.1 explicitly rather than silently rejecting it.
- Extend the authoring check beyond runtime paths; replace blanket directory exemptions with narrow, justified input/snapshot exceptions.

## Out of scope

- Translating deliberate multilingual test INPUTS or changing transliteration behavior.
- Rewriting historical captured output as though a different run produced it.
- Editing installed tracker-owned files or third-party snapshots solely because they contain another language.

## Verification

- The new check rejects current Russian ordinary scenario instructions and covers every project-owned authoring surface.
- Purposeful Unicode inputs and transliteration tests retain their behavior.
- Consumer artifact content is English, with no stale translation links.
- Record commands, exits, counts and commit; run applicable gates.
