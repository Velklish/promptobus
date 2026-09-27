# PB-308 · Complete the orchestration skill with the mechanism behaviour consumers still restate

- **Order:** 610
- **Scope:** [Reference](../../reference/README.md)
- **Created:** 2026-09-27
- **Dependencies:** none
- **Cost:** major

## Context

The installer lays out and owns the package's process skills, and a consumer's own orchestration skill is meant to shrink to its policy above the package (ADR-023). A consumer's review of 2026-09-27 compared its orchestration skill with `skills/orchestrate/SKILL.md` at v0.20.0. It found 37 statements about the package's own behaviour that the package skill does not hold: the package skill gives the command signature or nothing at all. The consumer keeps restating them until the package skill states them. The owner decided on 2026-09-27 that these statements move into the package skill.

Evidence: the statements, grouped by the package skill section that should hold them. Each must be checked against the code before it is written. A statement the code contradicts is dropped, not copied.

- **CLI:** only a Claude Code session leads a run, and why; the WORKER CHANGED BRANCH header and the branch-name template; the worktree path and branch come from `promptobus_task` and `status`; how task, session, directory and branch are named; `--title` versus `--task-title`, and the `·` join; `spawn` without `--task` refuses on a foreign task; `stop <address>`; a value from another harness's vocabulary is refused before the lift; the warden appears as a line in `status`, and the next call lifts it; a second `spawn` without `--worker` restarts the first worker; the first `spawn` creates the task; `dismiss`, `sweep`, `stop` and who may call them, and `done` stopping sessions and `--keep-sessions`; Codex elicitation is declined with `{ action: "decline" }`; `review` picks up a task by directory, the diff base, and that a new flag does not recreate a live reviewer; an active orphan and the printed `done --task` on a refused lift; `done` stopping sessions, `prune`, worktree removal and its 14-day threshold.
- **Tools:** the `promptobus_send` refusals (the participant list, a missing `artifactPath`, an unknown key); what `promptobus_task` returns; who writes the session binding (spawn, review, `claim`); the header with both ids and what `claim` names; a task of an earlier CLI has no owner; the MCP tool name in the prompt per harness; a session has one live binding.
- **Mail:** a message that arrives during a participant's turn runs on its next turn; drivers declare one activation method; a repeat notice for unread mail carries only what is new; self-wake and the orchestrator label at start; a Claude Code participant in `bypassPermissions` does not see postcards.
- **Model routing:** the role floors worker ≥ 5, approver ≥ 7 and reviewer ≥ 9; the penalty for live participants is part of `score` under `balance`; the catalog has no Anthropic models through Cursor.
- **Stops:** `status`, `spawn`, `review` and `done` substitute the harness's tool line; the warden journal entry, and the postcard being withdrawn once the stop is recorded.
- **Worker protocol:** the pre-hand-off records and the gate record, and their schema check at `send`.
- **solo-review:** open the file in the working copy before each finding.

## Work to do

- Add each statement to its section of `skills/orchestrate/SKILL.md` (the last one to `skills/solo-review/SKILL.md`), in the skill's register, citing the code or reference section it rests on.
- Drop a statement the code contradicts, and name it in the result.
- Keep the skill within the length the overlay and the skill check allow; a statement already in `docs/reference/` may become a link rather than text.

## Out of scope

- Consumer policy: which models a consumer forbids, where its runs are led from, its own gates.
- Changing the behaviour itself.

## Verification

- Each added statement names its code or reference source, and the skill checks stay green.
- The count of added and dropped statements adds up to 37.
