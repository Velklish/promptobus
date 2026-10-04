# PB-313 · The orchestrator's questions to the owner are self-contained, and a task is named with its title

- **Order:** 230
- **Scope:** [01. Overview](../../reference/01-overview.md)
- **Created:** 2026-10-01
- **Dependencies:** none

## Context

The owner could not follow a bus run of the backslop backlog (2026-09-30). The orchestrator's status reports named tasks by number alone ("BS-197 passed review"), so the owner had to open the queue to learn what each was. Its questions to the owner used words coined during the run: worker slugs such as `d179`, "piece", review codes such as F1.

The owner's standing requirements for questions to them:
1. a question is self-contained: it can be answered without context that is not in the question;
2. it uses no term or abbreviation the agent introduced itself; a new definition is used only after the owner has confirmed it;
3. a task is named by its number and its title, never by the number alone. Owner decision (2026-10-01): the title goes with the first mention in a message, every heading and every table row; later mentions in the same paragraph may use the number alone;
4. the goal is a question the owner can actually answer, not one where they press the recommended option; they must see what is asked and why.

`skills/orchestrate/SKILL.md` tells the orchestrator when to ask the user (the split approval at :16, the shape choice at :34, the envelope at :191) and gives the reporter its role (:26, :42), but says nothing about how a question or a status to the person is worded. The owner decided (2026-10-01) that the rule goes into this skill, into the Agent Workspace base rules and into backslop.

## Work to do

- `skills/orchestrate/SKILL.md`: one short rule for every message to the person — the orchestrator's questions and status reports, and the reporter's answers — carrying the four requirements; participant addresses (`worker:<slug>`) and review codes never reach the person without a plain description of the work.
- Where the skill names the moments to ask (split, shape, envelope), link to the rule instead of restating it.
- The skill changes through skill-creator: snapshot, test prompts "report the run status" and "ask the owner to approve a split", old against new, the viewer to the owner.
- CHANGELOG entry.

## Out of scope

- The delivery of questions (`promptobus_ask`, the survey tool): the rule is about the words.
- A consumer workspace's own orchestration policy: its own task in that consumer.

## Verification

- The rule is in `skills/orchestrate/SKILL.md` once; the moments to ask link to it (`grep`).
- The skill-creator comparison: the new version's status names every task with its title; its split question uses no worker slug or coined term and can be answered from the question alone.
- The repository gates exit 0.
