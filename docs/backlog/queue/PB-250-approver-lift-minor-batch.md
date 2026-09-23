# PB-250 · Minor batch: the approver lift — refusal paths, the brief, attachments

- **Order:** 240
- **Scope:** [03-cli § Review](../../reference/03-cli.md#review), `lib/approver.js`, `lib/review.js`, `lib/cli.js`
- **Created:** 2026-09-23
- **Dependencies:** none
- **Cost:** minor

## Context

Cut in the PB-249 re-triage. Three minor entries share one surface — `review --approver` and the approver preamble in `lib/approver.js` — and the queue's top reaches the same place: PB-240, the approver's editing tools in the shared clone. The batch rides with the run that takes PB-240, rather than on its own.

## Work to do

- [PB-225.1](../minor/PB-225.1-approver-attachments-outside-the-contract.md) — the approver is outside the attachment contract: either the reviewed address extends to an approver (`metadata.repoAbs`) and the preamble carries `ATTACHMENT_CONTRACT`, or the preamble says its attachments are not shown.
- [PB-237](../minor/PB-237-approver-lift-refusal-does-not-name-the-subject.md) — the "no such reviewer" refusal names the path it got and the paths the task has reviewers for, the way the refusal three lines below it already does.
- [PB-238](../minor/PB-238-review-has-no-brief-flag.md) — the approver's assignment reaches it at lift and stays in the task's record: `--brief` on `review --approver`, or a command of its own.

## Out of scope

- PB-240 and PB-222 — `major`, their own cards.
- Whether the approver rule itself is right: an approver follows a green review.

## Verification

- Each entry's own Verification, closed with `archive N.k --into 250` and one outcome line per entry in this card's `result.md`; gates green.
