# PB-365 · Export portable role instruction renderers while preserving native harness behavior

- **Scope:** [CLI role prompts](../../reference/03-cli.md), [Drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-08
- **Dependencies:** [PB-358 · Separate harness-specific prompt sources from shared contracts](PB-358-harness-specific-prompt-sources.md)
- **Cost:** —
- **Order:** 5

## Context

Role instructions are partly in skills and partly embedded in native runtime code. A BB integration needs the same protocol, role duties and evidence rules without inheriting process-specific CLI names, Stop hooks and worktree assumptions. Harness-specific instruction separation is already tracked separately; this task exports the portable role contract and runtime bindings rather than duplicating that source split.

Evidence: Source snapshot `9a2a758209802e0b9632aad958f862d15e2e4c30`: `lib/spawn.js:779` (worker prompt and harness literals), `lib/review.js:1411`, `lib/approver.js:195`, and `skills/orchestrate/SKILL.md`. BB SDK 0.6.15 `PluginAgentConfiguration` at `bundled-types/bb-plugin-sdk.d.ts:21818` limits dynamic instructions to 4096 characters.

## Work to do

- After harness-specific sources are separated, extract pure renderers for worker, reviewer, approver, teamlead, reporter and orchestration instructions.
- Parameterize only concrete runtime bindings: tool names, mailbox access, activation/continuation behavior and supplied task/snapshot/gate context. Retain common ownership, protocol and evidence semantics.
- Provide a reusable exported entry point for the BB plugin. Keep the existing native CLI callers and driver implementations.
- Place long standing BB instructions in plugin skills and task-specific inputs in initial prompts or artifacts; avoid configure truncation and unsupported hot reconfiguration.
- Document the portable/native source mapping in the relevant reference and package delivery surfaces.

## Out of scope

- No native permission, lifecycle, routing or message-store redesign.
- No new verdict/content acceptance semantics or broad configurable rendering framework.
- Do not combine unrelated Codex operational guidance fixes with portable extraction.

## Verification

- Capture representative native prompts before extraction and compare the intended unchanged output for every existing harness and role.
- Changing a BB binding affects only BB instructions; changing one native harness source does not alter another harness's output.
- Test protocol obligations, task/snapshot bindings and long BB instruction delivery without silent 4096-character truncation.
- Run relevant driver, pipeline and hooks regressions; verify packed and installed instruction entry points and links.
