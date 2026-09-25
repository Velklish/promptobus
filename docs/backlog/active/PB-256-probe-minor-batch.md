# PB-256 · Minor batch: the mutation probe — the replacement half of --mutate, and a red run that never reached the suite

- **Scope:** `scripts/mutation-probe.mjs`, `test/mutation-probe.test.mjs`, [contributing](../../guides/contributing.md) § the probe
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** minor
- **Previous order:** 250
- **Taken:** 2026-09-26

## Context

Two minor entries in which `npm run probe` prints the verdict of a probe that worked for a run that never reached the checks it was meant to redden. Both touch the same script and the same guide paragraph, so they go as one piece.

## Work to do

- [PB-188.2](../minor/PB-188.2-probe-replacement-side.md) — the `--mutate` replacement goes through `String.replace`: `\n` arrives as a backslash and an `n`, `$&` and `$1` substitute, and the tool warns only about the pattern half (`scripts/mutation-probe.mjs:86`, `:88`).
- [PB-241.1](../minor/PB-241.1-probe-reads-a-compile-error-as-red.md) — a `--run` with a build step reads a compile error of the mutation as red, with no reddened check named (`scripts/mutation-probe.mjs:103`, `:118`).

## Out of scope

- The four outcomes and the snapshot restore; the record forms the probe already writes.

## Verification

- Each entry's own Verification met on the tree, closed with `archive N.k --into 256` and one outcome line per entry in this card's `result.md`; gates green.
