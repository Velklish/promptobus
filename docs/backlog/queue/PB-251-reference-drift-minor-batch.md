# PB-251 · Minor batch: text that drifted from the tree — README gates, 03-cli, the command list

- **Order:** 250
- **Scope:** `README.md`, `README.ru.md`, [03-cli](../../reference/03-cli.md), `lib/cli.js`
- **Created:** 2026-09-23
- **Dependencies:** none
- **Cost:** minor

## Context

Cut in the PB-249 re-triage. Four minor entries in which a text says something the tree no longer does. The queue's top edits the same files — PB-245.1 and PB-239 both change 03-cli — so the batch rides with that run.

## Work to do

- [PB-247.1](../minor/PB-247.1-readme-gates-list-short.md) — `README.md` and `README.ru.md` list three of the five gates.
- [PB-249.1](../minor/PB-249.1-unknown-command-list-omits-stop.md) — the unknown-command refusal lists every command but `stop` (`lib/cli.js:13`).
- [PB-249.2](../minor/PB-249.2-reference-names-closed-pb-192-open.md) — 03-cli names the closed PB-192 as open (`docs/reference/03-cli.md:542`).
- [PB-249.3](../minor/PB-249.3-reference-identity-reader-present-tense.md) — 03-cli describes the identity reader from before ADR-010 in the present tense (`docs/reference/03-cli.md:15`).

## Out of scope

- Other stale sentences found while the batch is worked: each is its own minor entry, not a widening of this card.

## Verification

- Each entry's own evidence re-read against the edited text, closed with `archive N.k --into 251` and one outcome line per entry in this card's `result.md`; gates green.
