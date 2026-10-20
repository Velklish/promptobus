# ADR-037: BB admissions read owner-published current control

**Status:** Accepted
**Date:** 2026-10-20
**Deciders:** repository owner.

## Context

Launch context previously accepted a file chosen by the participant or an inline
snapshot. Neither identifies a shared owner authority for later admission. A
snapshot remains unchanged after revocation, and a constrained reviewer cannot
read an arbitrary external control file without widening its read roots.

The canonical task, participant binding and environment already identify the
owner. The current grant must be checked against that identity before existing
Promptobus entry points admit substantive work. Persisted legacy context is
historical evidence, not proof that authorization is still current.

## Options

- Keep launch-time inline/file authority: retains the old input shape but cannot
  establish current owner revocation for every admitted role.
- Give every participant direct access to the owner's control directory: shares
  storage while changing the constrained reviewer's filesystem boundary.
- Publish bounded current control under an immutable owner reference and recheck
  it in the runtime: adds an explicit initializer and revision checks while
  keeping provider read roots unchanged.

## Decision

Use owner-published current control. Before `task create`, the operator explicitly
calls `bb promptobus control publish --task TASK --initialize --input <JSON>` with
complete supplied owner confirmation and grants. The command does not derive
authorization from assignment prose or create a canonical task. The reference
contains the normalized control directory, exact owner task/participant/project/
environment/host/root identity and declared owner read roots. Task creation pins
that reference in canonical `task.adapter.bb.currentControl`; later updates
cannot replace it.

Every new launch uses `control: { mode: "current", reference }`. The runtime
validates the reference against the canonical owner and rereads current control
at existing Promptobus admission points, including constrained reviewer reads.
The reviewer receives no additional filesystem roots. File and inline launch
context may remain in historical bindings, but cannot authorize substantive work.
An existing legacy task cannot silently attach a reference through resume or a
fresh phase; continuation needs an explicitly initialized new task through the
supported route, preserving the old task and its evidence.

The bounded current document is at most 1 MiB and uses
`format: "promptobus-bb-control-v1"`, its exact reference, a revision, owner
confirmation, STOP, noNewStages and current grants. Each exact token record is at
most 256 KiB and uses `format: "promptobus-bb-token-v1"`, task, actor, token,
grantSha256 and state. A token identifies an immutable grant. It moves only from
active to ended; an ended token never becomes active again. Fresh phases query
their exact predecessor grant token and require its ended state, without a
growing ended-token list or history scan.

An update supplies `--expected-revision N`; stale compare-and-swap refuses.
Owner identity, token and session are checked independently of ordinary owner
admission. A closed, orphaned or unhealthy owner retains a deny-only recovery
route through its persisted identity. That route cannot clear STOP/noNewStages,
reconfirm ownership or issue grants. Revocation must remain possible after
normal admission has become unavailable. Fresh runtime observation of a missing,
errored or unknown owner forces the same deny-only route. The internal publication
contract carries `denyOnly`; omitting it conservatively permits denial only.

## Consequences

Admission can observe revocation through one owner authority without reading an
unbounded history or extending reviewer permissions. Operators must prepare the
complete owner input and initialize control before task creation; launch alone
does not publish a grant. Missing, mismatched, unavailable, ended or stopped
control refuses admission.

This decision guards existing Promptobus runtime entry points. It does not add a
native command scheduler, authorize arbitrary shell calls, change provider
permissions or establish physical Stop. Ending a grant prevents later admission;
already running calls still require the separate verified Stop and all-calls
release protocol. SDK fixtures establish the mechanism exercised by those tests;
an installed-plugin/provider workflow requires its own live evidence.
