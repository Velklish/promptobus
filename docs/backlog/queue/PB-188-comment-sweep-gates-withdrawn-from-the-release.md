# PB-188 · The two comment-sweep gates are withdrawn from the release: three rounds, four bypasses, and one false certificate

- **Order:** 210
- **Scope:** `test/comment-scan.mjs`, `test/comment-length.test.mjs`, `test/comment-links.test.mjs`,
  [contributing](../../guides/contributing.md) § the sweep
- **Created:** 2026-09-12, release run
- **Dependencies:** the sweep itself is `PB-172`; the removals it made stay

## What happened

Two gates were built to protect the comment sweep from rollback: one counting long comment runs
per file against a baseline, one holding the pointers the sweep left behind. They went through
three review rounds. Each round found the gate weaker than it claimed, and the orchestrator
announced before the third that another bypass of the same surface would take both gates out of
the release. The fifth round found **four**.

**Round 3** — the length gate compared nothing: the numbers beside each pending file were never
read. Fixed.

**Round 4** — the ratchet compared only the *count* of long runs, so deleting one long block and
adding another in the same pending file passed. Fixed by identity: each run hashed by its own
text. The link gate's floors (`seen > 50`, `checked > 30`) were replaced by a per-file baseline.

**Round 5, four bypasses, all still open:**

1. **`comment-scan.mjs:23`** — the scanner stops parsing a physical line at the first comment
   marker and holds no template-literal state. `/* x */ // one` followed by two `//` lines misses
   the three-line run; `const s = "[x](missing.md)"; // note` feeds the link gate a link taken
   **from a string literal**.
2. **`comment-length.test.mjs:31`** — the baseline is reduced to a `Set`, so **multiplicity is
   lost**: a copy of an already-allowed long block in the same pending file carries the same hash
   and passes both checks. This is the round-4 bypass — swapping debt — returned in a new form.
3. **`comment-links.test.mjs:154`** — the same `Set` for link targets: removing one of two
   identical targets is invisible. `lib/driver-cursor.js:22` and `:650` both point at
   `cursor-persist.js`.
4. **`comment-links.test.mjs:140`** — the semantic gate never compares `section.file`, skips a
   bound pointer when `under === null`, and `SYMBOL` accepts `if (...)` and arbitrary calls as
   declarations.

## Why the gates were withdrawn rather than fixed once more

The fourth bypass is not just another hole: **the gate issued a certificate it could not back.**
The round-4 report closed the pointer work with "98 pointers, 0 discrepancies by symbol" — a
number produced by the same check that accepts `if (...)` as a declaration and never looks at the
file. The review then found three bindings that had passed that certification and were wrong
(`lib/model-routing/catalog.js:1`, `src/legacy-store.ts:29`, `src/supervisor.ts:155`).

A gate that produces false certificates is worse than an absent one: the absent gate does not
mislead, and the work it guards gets read by a person. That is the whole reason the stopping rule
existed, and it was stated before the work rather than after the finding.

## What is withdrawn and what stays

- Both checks are demoted to `todo` with a pointer to this card. **The scanner and the ratchet
  code stay in the tree** — the next pass starts from them, not from nothing.
- **The sweep's removals stay.** Nothing about the cleaned comments is reverted; what is withdrawn
  is the claim that a rollback would be caught.
- The three bad pointer bindings are corrected by hand, and the result of that correction says so
  explicitly, because the automatic check is no longer a witness.
- `CHANGELOG` carries the withdrawal and its reason.

## Work to do

- Rebuild the scanner as a lexer that returns exact comment spans with state carried **across**
  lines: block open/closed, string, template literal, and continuation after `*/` on the same
  line. Fixtures for each of the four shapes above, positive and negative.
- Compare baselines as **multisets**, not sets, in both gates; a mutation case for "duplicate an
  existing allowed block" and for "remove one of two identical targets".
- In the semantic gate: normalise and compare the source path, require a real declaration or
  enclosing symbol for a bound section, and treat every unexplained skip as an error rather than
  silence.
- Only then re-enable the gates, and say in the contributing guide what each one does and does
  not catch.

## Out of scope

- `PB-172` itself and the comments it removed.
- The pointer corrections made by hand in the release run: they are done, and their evidence is
  reading, not the gate.

## Verification

- Each of the four bypasses above has a check that fails before the fix and passes after, and the
  mutation probe for it reddens the named case and nothing else.
- No statement anywhere in the tree claims the sweep is protected from rollback while these checks
  are `todo`.
