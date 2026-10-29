# PB-409 · The orchestrate skill has no planned whole-run pause on a harness limit window and no relift of dead teamleads with a continuation brief

- **Order:** 360
- **Scope:** [skills/orchestrate](../../../skills/orchestrate/SKILL.md), [Stops](../../../skills/orchestrate/SKILL.md#stops), [reference/03-cli § Spawn](../../reference/03-cli.md#spawn)
- **Created:** 2026-10-29
- **Dependencies:** none; related to the open minors PB-331.1 and PB-331.2 (what a relifted teamlead reports and binds)
- **Cost:** major

## Context

A consumer workspace's run, 2026-10-03. The owner decided that at 95 % of the five-hour Claude window the whole run stops and a timer is set to the reset. The pause lasted from 17:48Z to 20:06Z. Both teamlead sessions and one worker died during it: `claude logs <id>` answered "job not found". The root orchestrator lifted the teamleads again with `spawn --teamlead --slug <x> --brief <continuation>`. The continuation brief named the original brief and the root's unread mail. The new sessions rebuilt their state from files, among them the previous teamlead's own state file, and lost part of the context. The root invented the procedure as it went (the run journal, entry 17:20Z).

The skill covers a different case: one session that stops on its limit and is woken. It has no planned pause of the whole run. Evidence:

- Source: 2026-10-29, `grep -n -i "pause" skills/orchestrate/SKILL.md` prints lines 161 and 361 only. Line 161 says that `stop` and `done` are not a pause-and-resume mechanism for a Codex root; line 361 is the recovery of one idle BB participant. Neither says what a root sends to its teamlead and workers, where each writes its state, how the timer is set, or how a dead teamlead is lifted again.
- Source: the same file, line 213: the `near-limit` line of `promptobus models` names a harness whose window is at or past its threshold. It is the signal that could start the pause; nothing in the skill acts on it as a run-wide stop.

## Work to do

- Add a section to the skill for a planned pause of the whole run:
  - the owner sets the threshold; `near-limit` is one input, not the trigger by itself;
  - the root sends "pause" to its teamlead and its own participants;
  - each of them, before the end of its turn, writes a state file into `files/` of its task;
  - the root sets a timer to the reset of the window.
- After the reset the sessions that are alive continue on "continue". A session that died is lifted again with `spawn --teamlead` and a continuation brief that names the original brief, the state file and the unread mail. Check the commands in the section against the current CLI.
- Say in the section what the relift loses (a dead session's context beyond the state file) and point to PB-331.1 and PB-331.2 for what a relifted teamlead reports and binds.

## Out of scope

- An automatic pause by the bus itself.
- The choice of the threshold, which stays the owner's.

## Verification

- A text-contract test over the skill fails when the section, the state file in `files/` or the three items of the continuation brief (original brief, state file, unread mail) are removed from it.
- The commands named in the section run against the current CLI help (`promptobus spawn --help`).
- `npx --no-install backslop lint` and `npm run audit` exit 0.
