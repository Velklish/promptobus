# PB-410 · The orchestrator's root thread has no lifetime boundary, so a multi-day run pays its whole context on every turn and spends the subscription limit

- **Order:** 370
- **Scope:** [skills/orchestrate](../../../skills/orchestrate/SKILL.md), [Roles](../../../skills/orchestrate/SKILL.md#roles)
- **Created:** 2026-10-29
- **Dependencies:** none; related to PB-409 (state files of a paused run) and to PB-403 (the same run)
- **Cost:** major

## Context

A consumer workspace's Codex orchestrator led a run from 2026-10-22 to 2026-10-25 in one root thread. Every turn paid again for the whole accumulated context, and by 2026-10-26 the owner's subscription limit was spent until 2026-11-02. Another session continued the run from a hand-off file. The skill gives the root thread no lifetime and no restart from a hand-off file.

Evidence:

- Source: 2026-10-27, the session log of that root thread, `token_count` events: 5212 turns over 78 hours; input context per turn, median 176,633, p90 303,657, maximum 449,205 tokens; the sum of input is about 983 million tokens for one thread.
- Source: the same analysis over all sessions of 2026-10-20 to 2026-10-26: root threads about 4.7 billion input tokens, child threads 1.6 billion, automatic reviews 78 million.
- Source: 2026-10-29, `wc -w skills/orchestrate/SKILL.md` → 7647 words. The orchestrator keeps the skill in context for the whole run, so it is paid on every turn.

## Work to do

- Give the root thread a boundary in the skill: after a batch of tasks, or at a context threshold the owner sets, the orchestrator writes a hand-off file (task states, the owner's decisions, open branches and backups) and continues in a new thread from it.
- Reading large logs, histories and other repositories goes to a subagent that returns its conclusions, not the raw text.
- Measure what the skill brings into each turn and cut it; record the word count before and after.

## Out of scope

- The harnesses' own context compaction settings.
- The choice of models and plans.

## Verification

- A text-contract test over the skill fails when the hand-off rule and the restart of the root thread are removed from it.
- The word count of the skill before and after the change is recorded in `result.md`.
- `npx --no-install backslop lint` and `npm run audit` exit 0.
