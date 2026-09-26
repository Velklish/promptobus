# PB-272 · The package skill and lift texts describe TGM, teamlead and reporter, with the thresholds for raising a tree

- **Order:** 90
- **Scope:** `skills/orchestrate/SKILL.md`, the lift texts in `lib/spawn.js`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-26
- **Dependencies:** PB-268, PB-269, PB-270, PB-271
- **Cost:** major

## Context

The package skill tells one orchestrator how to run one flat task. With the tree of ADR-021 an orchestrator can be the top of a tree (the owner calls this role TGM) or a teamlead under it, and the skill must say which shape to raise and when. The boundary between a small matter and a large one is held by text, since the mechanism restricts only message types (PB-270).

The owner measured 33 task journals on this machine on 2026-09-26 (two read-only scripts over the task store): the median task had 3 pieces, 3 concurrent workers, 69 messages to the orchestrator and 1.1 hours; the five largest runs had 5 to 33 pieces, a peak of 3 to 7 concurrent workers, 400 to 832 messages to the orchestrator, 344 to 877 thousand characters of inbound mail and up to 16.8 hours — more than one orchestrator context. From that table the owner chose the thresholds below.

## Work to do

- The skill gains a section on the tree: one orchestrator up to 5 pieces, up to 3 concurrent workers, one repository group with one acceptance recipe, up to 8 hours; a top orchestrator with teamleads from 8 pieces, from 4 concurrent workers, two or more groups with different acceptance recipes, or a contract between groups that someone above both must hold; 6 to 7 pieces is the task owner's call.
- A teamlead section: what stays between siblings and what goes to the root orchestrator unasked — a change of logic, a change of requirements, a question the brief and the rules do not answer — and that the mechanism will refuse a `task`, `result` or `review` to a sibling.
- A reporter section for the person: what it answers from the journal, when it asks on the person's behalf (PB-281).
- The lift texts of teamlead and reporter carry the same rules in the imperative; the first `status` of a teamlead lists the rule files it read.
- The skill reaches the project through `install` (PB-268).

## Out of scope

- Consumer policy above the package — which harness a reviewer runs on, which models are forbidden — stays in the consumer's own texts.

## Verification

- The skill names the thresholds with the numbers above and cites the measurement date; `npm run audit` passes on the text.
- A teamlead lifted from the text sends its first `status` with the list of files read.
- The installed copy after PB-268 is byte-identical to the package's.
