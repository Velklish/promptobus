# PB-269 · spawn --teamlead lifts a child orchestrator at the install root on Claude Code

- **Order:** 60
- **Scope:** [03-cli § Spawn](../../reference/03-cli.md#spawn), `lib/spawn.js`, `lib/liftoff.js`, `lib/driver-claude.js`, the lift texts
- **Created:** 2026-09-26
- **Dependencies:** PB-265, PB-266, PB-267
- **Cost:** major

## Context

The owner's structure of 2026-09-26 (ADR-021): a top orchestrator may lift teamleads, each an orchestrator of its own child task, each a session at the install root — the directory where `promptobus.json` lives, where the top orchestrator itself sits. A teamlead's group is the set of repositories named in its brief, not a directory. Depth is exactly two.

A session at the install root shares that directory's project files with every other session there. [ADR-015](../../adr/adr-015-approver-lift-is-a-flag-on-review.md) measured the same shape for the approver at the clone root: Cursor reads project configuration only from the selected workspace's `.cursor/` and its hooks do not follow `CURSOR_CONFIG_DIR`; Codex reads project hooks and skills from the thread cwd, and placing them there mutates the tree. Claude Code takes its MCP config and plugin directory as per-session flags, so a lift there writes no project file. The card «Проектный слой приёмщика негде разместить безопасно ни на одном харнессе, кроме Claude» (PB-222) holds the return condition for the other two.

## Work to do

- `promptobus spawn --teamlead --brief <file> --task <root> [--slug <s>] [--strategy | --harness | --model | --effort]` creates the child task with `parent` set, registers `teamlead:<slug>` in the root task and `orchestrator` in the child bound to one session (PB-265, PB-267), and lifts that session with cwd at the install root, the brief in its prompt, the bus MCP entry naming the child task as its default and the root task as the one it reports to.
- Cursor and Codex are refused before start with the ADR-015 reason and the return condition of PB-222; `--dry-run` prints the teamlead plan.
- A repeat lift of a live teamlead address is refused as it is for a worker; a lift after the session died relifts into the same child task.
- The teamlead lift text: what it owns (its child task, its pipeline), whom it reports to (`orchestrator` of the root as `teamlead:<slug>`), what goes up unasked (a change of logic or of requirements, a question the brief and the rules do not answer), and the addresses of its sibling teamleads.
- Reference § Spawn documents the flag; `status` shows the teamlead under the root with its child task.

## Out of scope

- Teamlead-to-teamlead and teamlead-to-root routes (PB-270): this card creates the addresses.
- Two teamleads writing project files at the install root: on Claude Code none are written; the other harnesses are refused.

## Verification

- After `spawn --teamlead`, `status` prints the root with `teamlead:<slug>` and the child task beneath it; the teamlead's first `status` arrives in the root task's orchestrator mailbox from `teamlead:<slug>`; a `task` it sends to a worker of its child task is stored with sender `orchestrator`.
- `spawn --teamlead --harness cursor` and `--harness codex` exit non-zero with the ADR-015 reason; `--dry-run` starts nothing and prints the plan.
- Two teamlead lifts in a row leave `git status --porcelain` of the install root empty.
