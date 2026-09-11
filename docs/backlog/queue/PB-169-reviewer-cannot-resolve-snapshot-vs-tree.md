# PB-169 · A reviewer has nothing to resolve a snapshot-versus-tree discrepancy with: Bash is denied and no second immovable artefact exists

- **Order:** 70
- **Scope:** `lib/review.js` (`subject()`, `buildPrompt()`), `lib/driver-claude.js`
  (`REVIEWER_DENY`)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Recorded in the consumer's tracker as `BL-634.1` (ati-agents, 2026-09-10) with the note "the
change belongs in the promptobus package; the mechanism is a consumer, the repin follows".
Moved here on 2026-09-12 so the release can carry it. The consumer's copy is archived.

A run orchestrator proposed fixing this on the reviewer's side — "read `git diff <base>..<sha>`
instead of the working tree, that is immune to the directory moving" — and asked whether it is
cheaper than a line in the skill. It is not, for two reasons.

**Git is denied to the reviewer by the mechanism.** The deny list for Claude Code is
`['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']` (`lib/driver-claude.js`);
Cursor gets `['Write(**)', 'Shell(**)']`, Codex `['workspace-write']`. Bash is denied whole, so
the reviewer cannot call `git diff` in any form, and its own prompt says the same in words: "do
not run Git".

**Reading the working tree is a decision of this package, not an oversight.** `subject()` hands
the reviewer an immovable snapshot of the diff and explains on the spot why one snapshot is not
enough: "it is written once and never updated, while the author goes on committing… a review of
a stale file reports closed findings as open". The comparison against the live copy stands
there precisely against reporting already-closed findings as open. Replacing it with
`git diff <base>..<sha>` swaps one class of false report for another instead of closing a
defect.

The behaviour on a discrepancy is stated by the prompt and was followed literally: "If the
working copy contradicts the snapshot, do not run Git and do not file a finding; report the
discrepancy as unresolved and hand the orchestrator the exact verification command
`git show <sha> -- <path>`". That is exactly what reached the orchestrator of the 2026-09-10
run (`da-scope-t20260910-185436`,
`messages/20260910T195808618-0001-d2501c.json`).

So the question is not "tree or diff" but "what does the reviewer resolve a discrepancy with
once it has happened". Today: nothing — the resolution goes to the orchestrator or the human
whole.

## Work to do

- Decide whether to give the reviewer a second immovable artefact: the worktree's `HEAD`
  content as of the snapshot (`git show <sha>:<path>`, taken by the package in advance), so it
  can resolve "tree contradicts snapshot" itself without running Git.
- Or decide that the resolution stays with the orchestrator and record that as a decision —
  then the skill rule is the whole answer and this card closes on the record.

## Out of scope

- Removing `Bash` from the reviewer's deny list: the read-only guarantee rests on that list,
  and it is not to be touched for convenience of resolution.
- The ordering rule "the worker finishes first, then the reviewer" — that is the consumer's
  `BL-634`, needed regardless of what the reviewer is handed.

## Verification

- A reviewer that meets a moving working tree either resolves the discrepancy itself, or the
  hand-off is a recorded decision.
- The reviewer's read-only guarantee is not weakened: `Bash` stays in the deny list.
