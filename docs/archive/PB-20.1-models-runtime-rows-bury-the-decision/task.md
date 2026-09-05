# PB-20.1 · `models` text output buries the decision under two hundred unrated Cursor rows

- **Scope:** [03-cli](../../reference/03-cli.md) § Model routing
- **Created:** 2026-09-05
- **Dependencies:** none
- **Taken:** 2026-09-05

## Context

`promptobus models` prints a `runtime models — not rated, never chosen automatically` block listing every model the account exposes that the catalog does not rate. On an account with Cursor logged in, that block is the whole output: measured on this machine on 2026-09-05 during the PB-20 acceptance run, one `promptobus models --refresh` printed 19 candidate rows and **209** runtime rows, 205 of them Cursor's — the Cursor inventory is 211 models and the catalog rates 6 of them. The chosen tuple and the warnings sit at the two ends of a 240-line page, and a person reading it in a terminal scrolls past the answer to reach the warnings.

The block is not wrong and it is not noise in principle: an unrated model the account can run is exactly what a maintainer wants to see before adding a row. It is the volume that is wrong for the command a person types to ask one question.

Evidence: the full run is in the PB-20 result (`models --refresh`, three harnesses, 2.565 s); `test/fixtures/model-catalog/` holds the captured `cursor-agent models` listing the count comes from.

## Work to do

- Decide what the text renderer does with the block: a count with the first few names (`203 more — promptobus models --json for the list`), a per-harness cap, or `--unrated` to ask for the full list. `--json` keeps every row whatever is chosen — a machine reader wants them all, and `render(decision)` reads only the document, so the two outputs still cannot drift.
- If a flag is added, it goes in the § Model routing synopsis and in the `--help` text with the rest.

## Out of scope

- The decision document. `runtime` is closed on the schema and every row belongs in it.
- Rating more Cursor models. That is a catalog decision, not a rendering one.

## Verification

- The golden pair `test/fixtures/model-routing/decision.json` and `models.txt` is reproduced byte for byte after the change, or updated deliberately with the reason in the commit.
- A snapshot with more unrated rows than the cap renders the cap and the count; one with fewer renders them all.
