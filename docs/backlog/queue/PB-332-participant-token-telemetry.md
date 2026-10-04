# PB-332 · Participant telemetry counts tokens from the harness session logs, covers teamleads and the orchestrator, and a command reports a run

- **Order:** 130
- **Scope:** [03. CLI § Participant telemetry](../../reference/03-cli.md#participant-telemetry)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major

## Context

`done` appends one telemetry record per participant generation to `telemetry.jsonl`. The record carries wall time, mailbox idle time, delivery latency, bus counts and the limit windows at spawn and at end. The file outlives the pruned journals. Three gaps showed in run bs020 on 2026-10-03, when the orchestrator could see only the shared window percentage and not which participant spent it.

- **No tokens for Claude and Codex.** `throughput` is filled for 48 of 1016 records, all of them Cursor. It is null for every Claude (751) and Codex (214) record. Source: 2026-10-04, `jq` over `~/.agents/model-routing/telemetry.jsonl`. The data is on disk:
  - a Claude Code transcript carries `usage` on every assistant message: input, cache creation, cache read, output;
  - a Codex rollout carries a cumulative `token_count`. One Codex session of 2026-10-03 shows 4 920 266 input tokens, 4 746 240 of them cached, and 18 102 output tokens.

  The participant record holds the session id that names both files.
- **No teamlead or orchestrator.** Records exist only for workers (395), reviewers (371) and approvers (250). Teamleads and the orchestrator hold the longest histories, so they are the most expensive sessions of a run.
- **No report for a person.** `telemetryStats` is a programmatic entry; nothing prints a run.

Owner decision on 2026-10-04: statistics live in telemetry. The participant mailbox of PB-331 stays mail with a lifetime and does not become history.

## Work to do

- At `done`, read each participant generation's harness session log by its recorded session id and write input, cache-read, cache-write and output tokens. For Claude, sum `usage` over the generation's messages. For Codex, take the last `token_count` totals. A missing log leaves the fields null with the reason.
- Write records for teamleads and the root orchestrator as well.
- `promptobus stats [--task <id>]` prints a run: participant, role, harness and model, wall time, tokens by kind, bus counts.

## Out of scope

- Money.
- A quota share per participant. Participants share one window, so it stays null as today.

## Verification

- With fixture Claude transcripts and Codex rollouts, the recorded totals equal the sums in the fixtures; a test fails on the old `done`.
- A closed task with a teamlead has a teamlead record; a test fails on the old `done`.
- `stats --task <id>` prints a row for every participant of the fixture run.
