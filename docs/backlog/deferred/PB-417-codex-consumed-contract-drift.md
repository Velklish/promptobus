# PB-417 · Verify the Codex 0.167.2 approval contract before updating the consumed capture

- **Scope:** [Codex driver](../../reference/05-drivers.md), [Contributing](../../guides/contributing.md)
- **Created:** 2026-10-30
- **Dependencies:** none
- **Cost:** major

## Context

The previous 0.164.0 to 0.166.0 transition was completed by PB-416.4 (`fc03aa23e77675b41daa28ac99dbbb471dede8c6`). The audited driver now selects the committed 0.166.0 consumed capture. Installed Codex 0.167.2 introduces a measured consumed-schema difference: `CommandExecutionApprovalKind` changes from the `command`/`writeStdin` enum to `oneOf`, adding capability-scoped `humanCommand`. This card now addresses that exact 0.167.2 contract boundary; it does not claim an observed runtime bug or live compatibility.

## Historical planning evidence

The original TypeScript planning baseline found installed Codex 0.165.0 against the preserved 0.164.0 contract. The measurements below retain their original versions and source commits.

Evidence: `npm run codex-schema` exited 1 twice on frozen planning commit 7e0488b706f01211a8399b85f5b386a7cc39ee31 and once on original runtime commit 4503555d9b007bf8b78f4f2bef963b15bb2c2563. The installed generator produced 52 consumed schemas with an additive modelNotFound error case and Account.gcp; finite witnesses passed, but exact contract comparison failed. An official private installation of Codex 0.164.0 matched all 52 schemas and exited 0 without changing the global binary.

## Work to do

- Capture the consumed output of installed Codex 0.167.2 with exact generator/binary provenance and diff it against the committed 0.166.0 capture. Review the exact `CommandExecutionApprovalKind` enum-to-`oneOf` change and capability-scoped `humanCommand`; determine the required driver, fixture and security-inventory changes before accepting the capture.
- Preserve historical captures and add finite witnesses for the exact approval/security alternatives, including the existing `command`/`writeStdin` boundary and new `humanCommand` shape. Do not auto-widen accepted values or infer authorization semantics from the schema alone. Update the consumed capture only with matching source gates and independent review; decide selected-profile ordinary workflow qualification separately, retaining required available-subscription measurements as unmeasured until performed.
- Reconcile current capture/profile wording with the delivered PB-416.4 transition while preserving version-scoped historical measurements, including CLI holder wording that still names 0.156.1. Do not relabel the old 0.164.0/0.159.2 live evidence as 0.167.2 proof.

## Out of scope

- Disabling the exact schema gate, automatically widening approval/security values, claiming runtime certification from schema changes alone, or changing global tools as part of this maintenance.

## Verification

- The 0.167.2 generator's consumed output matches its accepted committed capture, and current/historical finite witnesses pass with explicit approval/security coverage. Record source identity, exact commands, binary identity, counts and exits. Ordinary selected-profile workflow commands and available-subscription measurements are separate qualification evidence, not implied by schema success.
- Independent review has no critical or major findings; unavailable live measurements remain explicitly unmeasured.

## Deferred

- **Deferred:** 2026-10-30
- **Reason:** PB-416.4 completed the prior 0.164.0 to 0.166.0 transition. The new measured 0.167.2 approval-contract drift requires explicit security review and capture maintenance; selected-profile runtime qualification remains separate.
- **Return condition:** the owner schedules the finite installed Codex 0.167.2 approval-contract review, or a required workflow needs that profile. Review the exact approval/security shape and accept a matching capture only after the required witnesses, gates and review. Select and qualify the runtime profile separately; preserve the historical 0.165.0 measurements above as history.

## Measured audit input, 2026-11-13

At baseline `51867619447b812a2a03fc80fa5b271490e5756c`, two retained parent control runs of `npm run codex-schema` each exited 1 against installed 0.167.2; the installed generator itself exited 0. The retained exact diff is the approval enum-to-`oneOf`/`humanCommand` change described above. These are schema observations: actual `humanCommand` semantics, live/account workflows, runtime compatibility and any capture change were not verified or performed by this audit.
