# PB-358 · Separate harness-specific prompt sources from shared contracts

- **Order:** 2
- **Scope:** [Participant prompts](../../reference/README.md)
- **Created:** 2026-10-08
- **Dependencies:** none
- **Cost:** —

## Context

The owner requested this small refactor as a planning record on 2026-10-08 while stopping a managed Codex run. Worker and reviewer prompts are assembled in `lib/spawn.js` and `lib/review.js`; the Codex root prompt is assembled in `lib/lead.js`, with driver phrases supplying some harness-specific guidance. Codex operational guidance needs a source boundary that can change without changing Claude, Cursor or OpenCode instructions.

Observed corrections concern persistent MCP reuse, actual identity and route preflight, and effective sandbox/network permissions. A known listener-dependent command needs supported command-level network permission before its first attempt. These observations do not establish that every historical failed test or hook was a Codex product defect. Already accepted PB-356 behavior must be referenced and preserved rather than reimplemented.

## Work to do

- Separate harness-specific prompt sources behind the existing driver boundary, keeping genuinely shared ownership, independent review, evidence and safety contracts shared.
- Place Codex worker, reviewer and orchestrator operational guidance in Codex-specific sources: persistent MCP reuse; actual native identity, task and address preflight; effective sandbox/network guidance for listener-dependent commands.
- Keep role profiles supplied by the owner, and preserve native event delivery without model polling or repeated temporary MCP processes.
- Document the source mapping so a Codex-only edit has an explicit review scope.

## Out of scope

- Changes to Claude, Cursor or OpenCode prompt behavior; generic task-runner defects; reimplementation of accepted PB-356; weakening refusals, guards, trust or review contracts.
- Implementation, new participants, gates and publication during shutdown; this record remains unstarted.

## Verification

- Capture representative worker, reviewer and orchestrator prompts for each harness before the refactor. Assert that non-Codex prompt content and shared contracts remain unchanged.
- A Codex-only source edit changes only the intended Codex prompt; test the supported listener-permission guidance, persistent MCP reuse and actual identity/route wording.
- Preserve accepted PB-356 lifecycle fixture behavior and evidence boundaries. Report existing reds with their actual source and exits rather than relabeling them as harness defects.
