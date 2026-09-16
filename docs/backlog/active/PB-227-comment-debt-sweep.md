# PB-227 · Sweep the remaining long-comment debt: the pending list holds 1282 runs and 42 more sit outside it

- **Scope:** comments in `lib/**`, `src/**`, `bin/**`, `templates/**`; the documentation they move into — `docs/reference/`, subsystem READMEs; [contributing](../../guides/contributing.md) § the sweep
- **Created:** 2026-09-16
- **Dependencies:** none for the sweep itself; `PB-188` rebuilds the gates and regenerates the pending list from whatever this card leaves
- **Taken:** 2026-09-16

## Context

The rule is the owner's decision of 2026-09-12: code is self-documenting, an inline comment
longer than two lines is forbidden, a nuance that does not fit moves to the documentation.
`PB-172` swept part of the tree and left the rest as a pending list so the gates could hold
the line; the gates were then withdrawn (`PB-188`) and the debt has been growing since.

Measured on `main` at `77b382f` with the gate's own scanner and run identity, over the tracked
`lib`, `src`, `bin`, `templates` code files (85 files): 65 files are on the pending list with
1282 listed runs, 58 of which no run answers any more; 42 long runs sit outside the list —
6 in `lib/answers.js` and `lib/send.js`, 36 swapped into listed files. The scanner itself has
a known blind spot (a backtick inside a regex literal opens a "template" state, nested
`${…}` templates confuse the exit), measured in the consumer's twin gate at 66 hidden blocks
of 651; the count above is therefore a floor, and `PB-188` recounts with the rebuilt lexer.

The cost is the same as in the consumer: this code is read by agents, and every paragraph
above a function is paid for in tokens on each read.

## Work to do

- Enumerate the runs with the scanner (`longRuns`, limit 2) into a working list: file, line,
  length. Sort every run into one of three piles: (a) a fact invisible from the code moves
  into `docs/reference/<subsystem>.md` or the subsystem README, a pointer of at most two lines
  stays beside the code; (b) a retelling of the neighbouring lines, edit history, a task
  number, a date — removed; (c) a constraint invisible from the code — compressed to two
  lines.
- Keep a ledger, one line per run: `file:line → pile → destination or what was dropped`. It
  is the evidence that nothing was lost silently; the reviewer reads it against the diff.
- Prove the code did not change: strip comments from both sides with the same scanner and
  diff — empty. The one hunk class that is allowed is a comment that was data (a `usage()`
  reading its own header), moved into a string constant with byte-identical output.
- The pending list is not edited here: it is `PB-188`'s file, and that card regenerates it
  from the tree.

## Out of scope

- The gates and the scanner — `PB-188`.
- Any change in behaviour; the pass is comments and documentation only, so a review can tell
  the two apart.
- Comments in `test/**` and `docs/**`.

## Verification

- The scanner's count over the four trees after the pass is the residual named in the result,
  and every remaining run over two lines is in the ledger with a reason.
- The comment-stripped diff against the base commit is empty, or names exactly the data-as-
  comment hunks and nothing else.
- For each fact moved to the documentation, the ledger names the destination and a grep for
  the fact's distinctive number or name finds it there.
