# PB-319 · A progress status wakes the orchestrator like a result does

- **Order:** 600
- **Scope:** [01. Overview § Warden](../../reference/01-overview.md#warden)
- **Created:** 2026-10-03
- **Dependencies:** none
- **Cost:** major

## Context

On 2026-10-03 a root orchestrator (a Claude Code session) ran a tree at v0.22.0 with two root workers, two reviewers and two teamleads. The task journal (`messages/`) held 71 messages to `orchestrator` after about 1.5 h:

| Sender | `status` | other |
|---|---|---|
| a Codex worker | 32 | 5 artifact, 2 question, 2 result |
| a Claude worker | 8 | 4 artifact, 1 question, 1 result |
| two teamleads | 8 | 5 question |
| two reviewers | 1 | 2 result |

48 of 71 were `status`. Every one of them reached the orchestrator as a warden knock and took a turn of its session; most needed no reply ("accepted", "waiting for the lease", "the gate is running"). The [orchestrate skill](../../../skills/orchestrate/SKILL.md) asks a worker for `status` "on every visible step", and the loop guard itself names only `task`, `question`, `review` and `result` as the types that ask for an answer.

The owner of the run decided to narrow `status` by brief for the rest of that run: start of a background run longer than ~5 min, and anything that changes the plan or blocks.

## Work to do

- Decide how a `status` reaches the orchestrator: no knock of its own (it rides with the next knock or the next mailbox read), or a knock only past a quiet interval; `task`, `question`, `review`, `result` and `artifact` keep knocking. Record the choice in the reference.
- Narrow the worker protocol in the orchestrate skill to milestone `status`: the first message, a background run announced with volume and estimate, a change of plan or a block.
- Keep a stalled participant visible: the stall line in the mailbox reply and `status` stay as they are.

## Out of scope

- Teamlead-to-root traffic beyond `status`.

## Verification

- A worker `status` alone does not knock the orchestrator; a `result` after it does, and the knock lists both.
- `npm test` and the repository gates exit 0.
