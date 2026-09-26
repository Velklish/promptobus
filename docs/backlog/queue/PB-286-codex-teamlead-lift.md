# PB-286 · A teamlead lifts on Codex: the bus launches it, so wake and session identity already exist

- **Order:** 380
- **Scope:** [03-cli § Spawn](../../reference/03-cli.md#spawn), [05-drivers](../../reference/05-drivers.md), [ADR-021](../../adr/adr-021-task-tree-and-governance-routes.md), `lib/spawn.js`, `lib/driver-codex.js`
- **Created:** 2026-09-27
- **Dependencies:** PB-269, PB-270, PB-265.1
- **Cost:** major

## Context

The owner asked on 2026-09-26, during a run in the owner's workspace, for Codex to carry orchestration so the Claude Code account is spent only on the top of the tree. This card is a design-and-measurement pass before any code: its first deliverable is evidence and a decision, its second the lift.

Two shapes were weighed. A Codex session a person opened cannot be the top orchestrator today: the warden wakes a Codex participant only through its holder, and `registerWake` needs the holder's socket, which exists only for a session the bus launched.

<!-- quote:../../../lib/driver-codex.js -->
export function registerWake(home, task, addr, env = process.env, session = null) {
<!-- /quote -->

A teamlead is the other shape: `spawn --teamlead` (PB-269) launches it, so a Codex teamlead would have a holder, its wake route and the session-record pointer that binds the record before launch (ADR-014, PB-265.1). The owner chose this shape for the card.

What keeps Codex out today is ADR-021's refusal, with the ADR-015 reason: a session at the install root shares that directory's project files, and Codex reads project hooks and skills from the thread cwd. What is already known, and what is not:

- A Codex participant's hooks and bus MCP entry live in its own `CODEX_HOME`; the owner's `~/.codex` is not written. Measured on every Codex lift of the same run.
- Workspace skills are copied into the lifted checkout's `.codex/skills`. At the install root that directory is the person's own; whether a teamlead lift there writes, overwrites or only reads it is not measured.
- Codex runs its Stop hook only on a turn that needs no follow-up (PB-185.2), so a Codex teamlead's loop guard cannot rest on the Stop hook alone; the holder drives turns. Not measured for a teamlead.
- A teamlead lifts participants on other harnesses. In the same run, commands inside the Codex participant sandbox could not reach another harness's login (`cursor-agent status` → `Not logged in`) or the keychain (`npm pack` → `SecItemCopyMatching failed -50`). The permission profile a Codex teamlead needs to run `spawn` and `review` is not measured.

## Work to do

- Measure one live Codex teamlead lift at a throwaway install root: every file written under the install root, tracked and untracked, byte-compared before and after two lifts in a row; where its skills and hooks come from.
- Decide how a Codex teamlead gets the install's skills and hooks without writing into the install root, and record it as an amendment of ADR-021 and ADR-015 by name.
- Measure whether a Codex teamlead can run `spawn` and `review` for Claude Code, Cursor and Codex participants under the participant permission profile; if not, name the narrowest profile that can, with its measured refusals.
- Decide the Codex teamlead's loop guard (holder-driven turns, Stop hook, or both) from a measured turn sequence.
- With the evidence in place, admit `--harness codex` for `spawn --teamlead` and let implicit routing consider Codex tuples for a teamlead; Cursor stays refused.

## Out of scope

- A Codex session a person opened as the top orchestrator: it has no wake route; a separate card if the owner wants it.
- Cursor teamleads.

## Verification

- Two Codex teamlead lifts in a row leave the throwaway install root's tracked and untracked content byte-identical.
- The Codex teamlead's first `status` reaches the root orchestrator as `teamlead:<slug>`; a message to it wakes it through its holder.
- The Codex teamlead lifts a worker on another harness in its child task and receives that worker's `result`.
- `spawn --teamlead --harness cursor` is still refused with the ADR-015 reason.
