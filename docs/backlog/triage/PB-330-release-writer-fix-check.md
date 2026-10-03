# PB-330 · The release writer pass does not say whether its documentation fixes carry a check that fails on the old text

- **Scope:** [Releasing § Technical-writer pass](../../guides/releasing.md#technical-writer-pass)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** minor

## Context

`AGENTS.md` step 3 says that a documentation fix carries a check that fails on the old text: a `quote:` block, a test or a lint rule. Releasing § Technical-writer pass does not say whether this binds the writer's fixes.

In the 0.24.0 pass the writer made two currency fixes without a check: `docs/reference/04-protocol.md:173`, the participant file stem list, and `skills/orchestrate/SKILL.md:61`, the send routes. The worker put the question to the orchestrator, and the orchestrator accepted both fixes without a check.

## Work to do

- State in Releasing § Technical-writer pass whether a writer fix carries a check. If it does, add checks for the two 0.24.0 fixes.

## Out of scope

- Style fixes, which change wording and no fact.

## Verification

- The guide states the rule. If the rule binds, the two 0.24.0 fixes each have a check that fails on the text before them.
