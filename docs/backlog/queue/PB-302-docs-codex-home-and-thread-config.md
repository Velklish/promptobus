# PB-302 · Document the actual Codex private-home contents and thread config overrides

- **Order:** 520
- **Scope:** [05-drivers](../../reference/05-drivers.md), [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

The Codex isolation reference gives closed enumerations that omit active hooks and trust overrides, so its security and delivery model cannot be reconstructed from the documentation.

## Evidence

- At b3d4a387, docs/reference/03-cli.md:65 and docs/reference/05-drivers.md:691-695 enumerate four home elements and say nothing else; 05-drivers.md:572-573 calls model_reasoning_effort the only per-thread config key.

- lib/driver-codex.js:378-384 writes <codexHome>/hooks.json when redirecting linked-worktree hooks; launch calls it at :1109-1110. The reference itself describes the home hook at :481-489.

- lib/codex-session.js:890-895 always adds bypass_hook_trust=true, adds features.hooks=false for the internal teamlead path and includes optional effort; :1291-1299 supplies this config to thread/start.

- Read-only threadStartConfig({role:'worker',effort:'high'}) returned {bypass_hook_trust:true,model_reasoning_effort:'high'}, assertion exit 0.

## Work to do

- Document home contents conditionally, including linked-worktree hooks.json, and enumerate the real thread/start overrides with their purpose.
- Preserve role-admission limits. The existence of an internal teamlead config branch must not be described as production support for Codex teamlead.
- Keep the existing workspace-skill precedence and copied-auth backlog scopes separate; this task fixes the reference only.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- Compare home-layout statements with worker/reviewer/approver launch code and existing layout tests.
- Compare per-thread config examples with threadStartConfig and schema fixtures; nothing depends on paid live turns for this documentation-only correction.
