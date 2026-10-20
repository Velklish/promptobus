# PB-384 · BB-managed runs need task-scoped owner authorization for agent-origin approval requests

- **Scope:** [BB-managed participant workflow](../../reference/01-overview.md), supported BB permission/delegation contract and its Promptobus consumer
- **Created:** 2026-10-19
- **Dependencies:** a supported BB task-scoped permission/delegation capability; establish the contract or record the upstream requirement before implementation
- **Cost:** major

## Context

In a consumer workspace run on 2026-10-19, the owner explicitly authorized a bounded Promptobus task and delegated its nondestructive command approvals. The installed BB permission policy, including `resolvePermissionEscalation`, still rejected non-user initiators. Managed launch/resume remained agent-origin when Accept Edits was selected. A genuine user composer Send enabled user-reviewed eligibility for that turn; the command still required a separate supported Allow once decision. Each approver therefore needed another manual copy/Send before eligible command approval. These are observed policy states, not proof that the intentional BB initiator policy is an implementation bug.

A later approver also selected its preparation-only guard in a genuine user turn. The read-only preflight failed before any target command or approval request; the already sealed user guard remained valid. Retain this as a separate workflow error, not as evidence that a permission was granted or that the proposed BB capability already exists.

Evidence: saved task authorization, managed launch/resume and effective-mode records, genuine composer turn records, individual approval/refusal receipts and the preflight failure. Immutable originals and local locations stay in the run-owned sidecar; this portable card contains no private ledgers, command arguments, account identifiers, personal paths or authorization tokens.

[PB-381](PB-381-orchestration-obtainable-admission-evidence.md) detects and plans an obtainable execution route and unavoidable human steps. It does not provide the BB capability that removes repeated manual Send. [PB-373.1](PB-373.1-bb-approval-resolved-tool-rejected.md) concerns a resolved approval whose tool result is rejected, a different defect.

Next step: future triage review with an explicit BB capability/dependency assessment. Filing is authorized; implementation is outside the current execution batch. Record an upstream feature/dependency locally if needed; filing this card does not authorize contacting another maintainer or modifying a remote platform.

## Work to do

Recovery audit, 2026-10-20, priority: external dependency decision before promising autonomous BB acceptance. Official BB tag `desktop-v0.46.1` resolves to `411eac54ac16d0a3cb57d1de8396d37564884a73`. Its `apps/server/src/services/threads/thread-runtime-config.ts` function `resolvePermissionEscalation` returns `deny` for every non-user initiator and `ask` only for user. The bridge permission policy denies interactive requests under `deny`; the source test matrix encodes that distinction. This source route has no task-delegation input. Source inspection is not a fresh live approval test. Prepare a concrete upstream proposal on the official repository, with owner-established provenance and revocation checked by BB; publish it only with explicit authorization. Until a supported extension exists, report the dependency rather than replacing initiator or promising that a skill can grant permission.

- Establish an official supported BB contract for one owner authorization scoped to a run/task and its declared participants, workspaces and operation classes. If BB exposes no such capability, record the necessary upstream feature/dependency and exact consumer contract. Promptobus instruction changes alone cannot complete this task or change a closed BB policy.
- Under that valid owner grant, a managed participant launch/resume can request supported per-command approval without another hand-copied composer Send in every thread or phase. Preserve accurate agent-origin attribution. Record actual execution approval separately through the supported BB decision/delegation flow; an owner grant is not a fabricated per-command decision or successful execution.
- Enforce grant identity, operation/workspace scope, validity, revocation, Stop and quota boundaries. A new scope still requires explicit authorization. Missing, mismatched or revoked authorization must fail closed; ordinary sandbox and per-command deny semantics remain effective.
- Update the actual BB integration consumer and canonical [orchestration guidance](../../../skills/orchestrate/SKILL.md) only against the supported contract. Do not promise that Promptobus can implement an unavailable BB policy change by itself. Keep a concrete upstream blocker explicit until the required capability exists.
- Reuse the first-real-card and permission-planning requirements in [PB-381](PB-381-orchestration-obtainable-admission-evidence.md), resource/capacity rules in [PB-382](PB-382-optional-resource-scoped-machine-lease.md), and compact current evidence rules in [PB-383](PB-383-compact-current-review-evidence.md), rather than adding a generic authorization framework.

## Verification

- After one scoped owner authorization, one separately authorized real managed task completes worker, independent review and exact-current-main approver gates/acceptance without hand-copied composer Send between stages. Reuse actual work and checks; do not substitute a dummy model capability probe.
- Original logs distinguish the owner grant, accurately agent-origin approval request, actual per-command decision and execution result. Neither Accept Edits nor a form reply is treated as user-origin proof. Publication remains governed by the task's actual scope.
- Deterministic controls exercise missing, wrong-task, wrong-workspace, out-of-scope and revoked grants, Stop/quota closure and per-command denial. No execution or automatic permission widening follows a refusal.
- Independent readback verifies behavior and evidence availability. Any future live validation needs separate authorization. Filing alone runs lightweight tracker/publicity/diff checks, no model or native probes.

## Out of scope

- Implementation in the current execution batch, an additional current card, or a claim that this future item fixes today's approver route.
- Forged user messages or initiators; blanket global/default/full/auto permission profiles; actor or transport substitution after a refusal; private BB state or runtime edits.
- Disabling sandbox or approval checks, bypassing a denied command, waiving review/gates/acceptance, automatic publication, or remote upstream changes.
- New paid/native/model/SDK/Stop probes, OS inventory or a generic permission framework.
