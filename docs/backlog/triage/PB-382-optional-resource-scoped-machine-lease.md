# PB-382 · Isolated work must not require a global machine lease; lock only conflicting resources and controlled measurements

- **Scope:** [Machine leases and participant coordination](../../reference/01-overview.md), canonical orchestration workflow and actual consumer scheduling guards
- **Created:** 2026-10-19
- **Dependencies:** none
- **Cost:** major

## Context

Canonical orchestration guidance requires a host-wide lease for ordinary measuring/gate work. In the observed ATI Agent Workspace run, this grew into one queue for isolated setup, focused tests and no-model schema capture. A job awaiting user permission retained the generic queue while other authorized cards were idle. On 2026-10-19 the owner explicitly chose resource-scoped parallelism instead.

Separate worktrees do not make every operation independent: output directories, temporary state and writable caches must also be isolated. A controlled diagnostic that deliberately uses a default shared cache is an explicit exception, not a reason to make every other task wait for generic compute capacity. A late permission answer cannot authorize a write after its resource authority has changed.

Evidence: the saved redacted scheduling incident, the initial machine queue and pending permission boundary, followed by the explicit resource-scoped owner decision. Run-owned sidecars retain local evidence locations; this portable card contains no private process arguments, personal paths, account identifiers or runtime tokens.

Related [PB-381](PB-381-orchestration-obtainable-admission-evidence.md) addresses obtainable admission evidence and upfront permission planning. This card separately removes mandatory global lock acquisition from workflow and guards; neither task replaces product FIFO/keyed-lease correctness or load-test diagnosis. Future triage review is the next step. Filing is authorized; implementation is outside the current execution batch.

## Work to do

- Remove mandatory global machine lease acquisition for independent source work, setup/build, no-model capture, focused checks and ordinary full suites. Permit concurrency within the approved card/actor limit after confirming distinct worktree, build output, temporary root and writable cache ownership.
- Reserve exclusivity only for a named concrete conflict: publication or mutation of the same repository main/ref, an actually shared mutable path/service, or an explicit performance/controlled-load measurement whose result depends on competing work. Block only relevant competitors; independent suites may overlap.
- Preserve the public generic lease API and FIFO/keyed correctness as optional/existing-user features. Do not delete that feature or invalidate its tests merely because ordinary orchestration no longer requires acquisition.
- Update canonical `skills/orchestrate/SKILL.md`, BB-specific launch/run guidance and operational guards, and actual duplicated ATI consumer orchestration policy together. Identify the real duplicated paths before editing; do not update the frozen runtime of an ongoing run.
- Make routine writable caches and outputs task-owned. Record any diagnostic default-cache exception and its exact resource claim; prevent conflicting writes to the same path rather than reserving the entire host.
- A pending user permission request must not reserve generic compute capacity. When a delayed command becomes executable, revalidate current token/scope and the actual resource authorization immediately before execution; stale or revoked authority refuses that command without blocking unrelated work.
- Preserve task-owned call/phase completion, confirmed owned-job blockers, exact command receipts, independent review, exact-SHA acceptance, product/security/release gates and quota limits. Retain UNKNOWN and red-test evidence; concurrency is not an environmental exemption for failures.
- Document the isolation contract and optional controlled-measurement mode without adding a universal scheduler/capability framework or an OS-PID attribution admission gate.

## Out of scope

- Implementation in the current execution batch, new implementation actors or expanding its approved task count.
- Removing sandbox/permission restrictions, forging user origin, approving on the user's behalf, changing global/default/auto/full profiles or substituting actors/transport after refusal.
- New SDK/Stop/native model probes, process inventory, cleanup/signals, stopping other runs, ignoring confirmed survivors or weakening product/release checks.
- Rewriting the lease FIFO/keyed algorithm, claiming historical descendant drain, or attributing unclassified red tests to concurrency without required repeat/base evidence.

## Verification

- A scenario regression starts two suites with isolated worktree/output/tmp/cache resources and proves both progress without acquiring a global lease. A conflicting same-path writer is blocked; changing it to a distinct path permits progress.
- Same-repository main/ref publication remains keyed and serialized, while publication to a different independent repository is not blocked by that key. Retain existing FIFO/keyed lease regression coverage.
- An explicit controlled performance/load measurement excludes competing measured work for its declared scope; ordinary gates do not silently enter that mode. Cover intentional concurrency inside one controlled measurement without admitting unrelated interfering jobs.
- A pending human approval leaves unrelated isolated checks runnable. After the resource claim is revoked or reassigned, late approval cannot execute the stale command; test the execution-time authority boundary rather than only message text.
- Preserve actual task-owned call completion and failure evidence in the scenarios. Validate decisions and observable concurrency/resource behavior, not string-only instruction checks. Use local fixtures or bounded readback; no new model/SDK/Stop probes.
- Validate the tracker and affected workflow/consumer documentation with normal lightweight checks. Implementation-specific regressions and required acceptance gates belong to the separately authorized future task; filing alone requires no full suite.
