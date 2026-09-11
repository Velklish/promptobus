# ADR-009: A reviewer does not resolve a snapshot-versus-tree discrepancy; the orchestrator does

**Status:** Accepted
**Date:** 2026-09-12
**Deciders:** Павел Ким (owner), decision of 2026-09-12 on PB-169 of the package release run

## Context

`review` hands the reviewer an immovable snapshot of the diff and, in the same breath,
explains why one snapshot is not enough: it is written once and never updated while the
author goes on committing, and a review of a stale file reports closed findings as open
(observed twice on 2026-09-06). The remedy in the prompt is a comparison against the live
working copy before every finding.

That comparison can contradict the snapshot, and when it does the reviewer has nothing to
resolve it with. `Bash` is denied to a Claude Code reviewer whole — `REVIEWER_DENY` in
`lib/driver-claude.js` is `['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch',
'WebSearch']`; Cursor gets `['Write(**)', 'Shell(**)']`, Codex `['workspace-write']` — so
it cannot call `git diff` or `git show` in any form, and its own prompt says the same in
words. The snapshot is the only fixed thing it holds.

The behaviour on a contradiction is stated by the prompt and was followed literally on the
run of 2026-09-10: file no finding, report the discrepancy as unresolved, and hand the
orchestrator the exact verification command `git show <sha> -- <path>`. So the question is
not "tree or diff" — an earlier proposal to have the reviewer read `git diff <base>..<sha>`
instead of the working tree swaps one class of false report for another and is denied to it
anyway. The question is what resolves a discrepancy once it has happened. Today: nothing
inside the session.

## Options

**A — give the reviewer a second immovable artefact.** The package also snapshots the
worktree's `HEAD` content of every changed path (`git show <sha>:<path>`) beside the diff.
The reviewer can then separate the two causes without Git: if the snapshot's line matches
`HEAD` at that sha, the snapshot was faithful and the author has moved on; if it does not,
the snapshot was taken over a dirty tree and the content was never committed.

**B — record that resolution belongs to the orchestrator.** Nothing new is written; the
skill rule and the prompt sentence are the whole answer, and the decision is written down
so the absence stops reading as an oversight.

**C — relax the deny list** so the reviewer runs `git show` itself. Named only to be
refused: the read-only guarantee of the reviewer rests on that list, and it is not spent on
the convenience of resolving a discrepancy. This was out of scope on the card and stays out
of scope here.

## Decision

**B.** Three reasons, and the first is the one that decides it.

**A is partial by construction.** It closes the discrepancy on the diff's own paths only,
while the prompt sends the reviewer into the working copy considerably wider than that —
"read it freely: call sites of changed methods, neighboring code, tests". A file the
reviewer opens for context can have moved exactly as a changed file can, and an artefact
built from the diff's paths says nothing about it. So A buys protection in the region
where the reviewer already has a fixed reference and none in the region where it has not.

**A is expensive in the budget that matters.** Measured 2026-09-12 on a seven-file branch
of this repository: the diff was 22 422 bytes, the full `HEAD` content of the same files
306 067 bytes — 13.6×. It would be written on every review and on every re-review and read
by a model whose context is the constraint. The ratio is one branch's and will differ
elsewhere; the decision does not rest on the number, and the number is recorded so nobody
has to re-measure to re-open the question.

**A guards a report the prompt already forbids.** On a contradiction the reviewer files no
finding at all. The defect A would prevent — a closed finding reported as open — is closed
by the instruction. What was genuinely open was only who takes the next step, and the
answer "the orchestrator" is correct by construction, because the remedy for a stale
snapshot is a re-review and only the orchestrator can start one.

**The read-only guarantee is not touched.** `Bash` stays in the deny list. This is stated
as its own line because it is the first thing a later pass will offer to simplify.

**The orchestrator already holds both halves of the answer** when a discrepancy arrives.
The report carries the exact verification command, `git show <sha> -- <path>` with the
worktree HEAD the prompt named, so the check is a paste and not a reconstruction. And
`promptobus review --task <id>` re-snapshots — the remedy whenever the answer is that the
file has aged. Neither needs anything the reviewer does not already send.

## Consequences

- A discrepancy costs the orchestrator one command and, usually, one re-review. That is
  the price of the decision and it is not hidden: it is a hand-off, not a resolution.
- The reviewer's session gains nothing and loses nothing. `lib/review.js` `subject()` and
  `buildPrompt()` are unchanged by this ADR; what changes is that their behaviour is now
  explained in `docs/reference/03-cli.md` § Review rather than inferred from the code.
- **Revisit when the wider-reading premise stops holding.** The first reason above rests
  on the reviewer being told to read the working copy beyond the diff. If a future prompt
  narrows the reviewer to the changed paths alone, A becomes complete rather than partial
  and the trade changes — at which point only the byte cost and the already-forbidden
  report remain against it.
- The ordering rule "the worker finishes first, then the reviewer" is a separate remedy in
  the consumer's own tracker and is needed whatever the reviewer is handed. It reduces how
  often a discrepancy happens; it does not change who resolves one.
