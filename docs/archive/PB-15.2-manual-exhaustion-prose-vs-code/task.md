# PB-15.2 · `manual_exhaustion` means two different things in the prose and in the code

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none

## Context

The reason-code table in [03-cli](../../reference/03-cli.md) § Model routing reads:

> `manual_exhaustion` | `exhausted` | A person marked the harness exhausted; cleared only by `--clear-exhausted`

`markExhausted` (`lib/model-routing/cache.js`) writes that code on a path where no person is involved at all: a lift that failed because the limit was spent, when the harness named no reset time. Its own comment says so — "no reset makes it `manual_exhaustion`, the sticky kind" — and the Availability subsection of the same reference file says the same thing two screens further down, next to the note that its `source` is `probe` and not `manual` precisely because a person did not type it.

So the table's prose and the code disagree about who the code means, while the rest of the file agrees with the code. PB-15 hits this from the adapter side: the Claude Code late-start hook marks a machine-observed limit and it lands as `manual_exhaustion`, which a person reading only the table would read as "somebody marked this by hand".

The disagreement is in the WORDS, not in the behaviour — nothing needs to change about what is written to the cache. What carries "only a person clears this" is the code; what carries who learned it is `source`. The table names the wrong one of the two.

## Work to do

- Reword the `manual_exhaustion` row so it describes what the code actually means: an exhaustion with no known reset, whether a person marked it or a lift hit the limit and the harness named no reset time — cleared only by `--clear-exhausted`, never by time and never by a later probe.
- Check the same row in `schemas/model-routing/snapshot.schema.json` and in ADR-003's code list; the drift check compares the lists, not their prose, so a wrong description passes today.

## Out of scope

- Renaming the code. It is in the snapshot schema enum, in ADR-003 and in a written cache; a rename is a contract change and this is a wording fix.
- `markExhausted`'s behaviour, which the Availability subsection already describes correctly.

## Verification

- The row and the Availability subsection say the same thing about who may produce the code.
- `npm test` stays green: the drift check compares code lists, so this is a prose change only.
