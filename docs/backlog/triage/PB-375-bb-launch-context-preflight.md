# PB-375 · Validate executable role and control context before admitting a BB participant

- **Scope:** [BB host context](../../reference/02-host.md)
- **Created:** 2026-10-13
- **Dependencies:** none
- **Cost:** —

## Context

On 2026-10-13 a BB worker authenticated its task but ended its first work turn because the assignment named current control without its exact location and the host context returned `skills=[]`. The selected role existed in the installed plugin catalog. A later Root supplement supplied the role text and control location; by the next admitted stage, the shared account had reached its soft threshold.

Evidence: [run measurements, context admission observation](../../evidence/bb-orchestration-2026-10-13.json); official `bb thread log thr_uf9gddq54a --json --all`, exit 0, completed message seq 97. The provider bridge itself had already passed authenticated task/mailbox/send on clean source `6fbefba108b614eb66657eabda24369f6e975fd0`. This entry concerns missing executable launch context; the extent of automatic validation remains a design question.

## Work to do

- Define the required launch context for each role: authenticated task/actor, exact owned roots, selected role resource or complete literal role, current command grant, its control read route, preparation commands and quota policy.
- Validate declared resources against the provider's permitted read roots before the substantive assignment is delivered. A constrained reviewer gets authorized inline context when an external control file cannot be read.
- Refuse an incomplete context with one concrete diagnostic before implementation or suite execution. Do not call an empty host skill list proof that the selected role is absent.
- Perform the existing authenticated bridge check in the participant's first turn; do not create a separate diagnostic model session per ordinary worker or retry a known permission refusal in new threads.
- Distinguish configuration readiness from an actual authenticated provider workflow. Preserve explicit user approval requirements and record what has not been checked.

## Out of scope

- Approval bypass, global provider installation/configuration or renewed probes of a provider excluded by the owner.
- Reopening the already repaired top-level MCP object schema defect.

## Verification

- Missing role resource, unreadable declared root and absent required control route refuse deterministically with the missing field named.
- Complete inline context admits the constrained reader without asking it to read an unauthorized external file.
- An empty host catalog plus a valid declared plugin role succeeds; a missing declared role does not.
- A bridge refusal is reported once, with no substitute identity or automatic new participant. Measure additional model turns and preserve full commands/exits on the accepted candidate.
