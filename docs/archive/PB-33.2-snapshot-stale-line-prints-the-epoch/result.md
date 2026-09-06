# PB-33.2 · Result

**Closed 2026-09-06.** Completed by the approver before the tag. The per-harness `snapshot-stale` warning reads `checkedAt` through the same rule the header uses: the epoch (`NEVER_CHECKED`) prints as "never checked", any other stamp as "checked at <stamp>". One expression in `resolver.js`, no other change.

**Verification.** `npm test` 47/47 on `main`; the golden pair unchanged (its harnesses were checked).

**Documentation in the same pass.** Not required: the reference already fixes the epoch as "never checked".
