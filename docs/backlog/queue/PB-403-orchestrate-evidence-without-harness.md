# PB-403 · The orchestrate skill does not forbid a bespoke verification harness, so runs build receipt packets instead of running the gates

- **Order:** 310
- **Scope:** [skills/orchestrate](../../../skills/orchestrate/SKILL.md), [Worker protocol](../../../skills/orchestrate/SKILL.md#worker-protocol), the BB participant skills in `integrations/bb/skills/`
- **Created:** 2026-10-27
- **Dependencies:** none; a consumer workspace filed the matching change to its own orchestration skill on 2026-10-27
- **Cost:** major

## Context

During the runs of 2026-10-20 to 2026-10-26, a Codex orchestrator wrapped every command in its own script. The script wrote a receipt with argv, exit code, hashes and time. Each participant result became a frozen packet sent to a separate review and a "GO" step. The packets broke on message-format mismatches and were rebuilt, so the work ran in sequence. The skill's worker protocol says how a result is reported, but it does not say that the repository gates and the report already are the evidence.

Evidence:

- Source: 2026-10-27, `find ~/.bb/thread-storage -maxdepth 4 -name 'run*.py' | wc -l` → 131; receipts, manifests, review-ready and closure files under the same storage → 11001; `du -sh ~/.bb/thread-storage` → 19G.
- Source: Codex session `01a164a3`, 2026-10-25 18:41, the orchestrator's answer to the owner: the custom test stand duplicated Promptobus checks, froze files that change, and misread real message formats; it caused most of the recent delays.
- Source: 2026-10-27, the same run continued in a Claude Code session closed PB-396, PB-374 and PB-373 without wrappers. Command, exit code and gate count were recorded in the report and in `result.md`. Live parts went to PB-374.1 and PB-373.16.

## Work to do

- State in the skill that evidence of a check is the command, its exit code and the gate count in the participant report and in `result.md`. The repository gates (`backslop gates`) and the package's own live scripts do the checking. The orchestrator does not add wrapper scripts, receipt files, hash manifests or frozen review packets.
- State that a task's closing criteria must be checkable on the current machine. A live measurement that needs an unavailable resource (another OS, an exhausted limit, an owner action) moves to a child card, and the parent closes on the checkable part.
- Apply the same rule to the BB participant skills in `integrations/bb/skills/`: the runs above went through BB, and their participants read those skills, not `skills/orchestrate`.
- Keep the wording consistent with the consumer workspace orchestration skill.

## Out of scope

- Dropping the independent diff review or the mutation probe.
- BB approval eligibility for agent-origin commands (PB-384).

## Verification

- A documentation check goes red when the evidence rule or the ban on a bespoke harness leaves `skills/orchestrate` or any BB participant skill.
