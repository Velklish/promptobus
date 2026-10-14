# PB-373 · Admit Cursor and OpenCode BB workers and Cursor approvers

- **Scope:** [BB plugin provider selection](../../../bb-plugin-promptobus/README.md#provider-and-model-selection)
- **Created:** 2026-10-12
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 230
- **Taken:** 2026-10-12

## Context

The BB facade admits only Codex although BB already exposes Cursor and OpenCode ACP providers. The owner requested Cursor/OpenCode workers for bounded tasks and Cursor approvers before starting a backlog run.

Evidence: 2026-10-12, source b8bc87317855fc463d0769a2954b75acca580cb7. `bb-plugin-promptobus/routing.ts` fixes ordinary roles to Codex; `protocol.ts` fixes execution harness/provider; `runtime.ts` constructs Codex participant bindings. `bb provider list --environment env_zkxea38942 --json` exited 0 and reported available `acp-cursor` and `acp-opencode`. `bb provider models acp-opencode --environment env_zkxea38942 --json` exited 0 with 31 models, including two contributor entries. These reads prove provider/catalog availability, not model-turn or workflow admission.

## Work to do

- Admit explicit Cursor and OpenCode workers and Cursor approvers through the existing SDK lifecycle.
- Preserve Codex defaults and the constrained Codex reviewer/governance roles.
- Record the selected provider and native harness, and carry that provider through preparation, spawn, tool identity, recovery and acceptance predecessors.
- Require the selected provider's permission support and its own model, health and usage observations.
- Update the provider contract and document the evidence boundary.

## Out of scope

- New native drivers, provider installation, global configuration, registry publication, or support for arbitrary providers.
- OpenCode approvers, ACP reviewers, reduced reviewer permissions or invented usage/model availability.
- Changing the owner's current backlog run thresholds or starting that run.

## Verification

- Regression tests fail on the old selection and permission guards; the same tests pass after the change.
- SDK lifecycle fixtures cover both worker providers and a Cursor approver, including identity and current predecessor checks.
- Unavailable providers/models, unsupported permission modes, wrong role/provider pairs and cross-provider routes refuse before reservation/spawn.
- Repository gates, plugin tests/typecheck, committed mutation probes and independent review pass.
- Live workflow checks use disposable repositories and preserve exact commands, exit codes, participants and remaining limitations.
