# PB-387 · BB admission needs bounded current control independent of history growth

- **Order:** 340
- **Scope:** [BB host boundary](../../reference/02-host.md), launch-control reader and current-state publication
- **Created:** 2026-10-20
- **Dependencies:** coordinate the launch preflight contract with PB-381
- **Cost:** major

## Context

BB admission reads the entire consumer control file with a 1 MiB limit before selecting the active grant. Historical grants, telemetry and JSON indentation therefore participate in the availability of current work.

Evidence: `bb-plugin-promptobus/host-integration.ts` calls `readDeclaredFile(..., 1024 * 1024)` before projecting current control. In a retained consumer run on 2026-10-20, the original event sequence measured 1,061,775 bytes, compacted to 940,766 bytes with semantic equality, and later measured 1,062,008 bytes after a writer expanded formatting again. The public operation refused with `launch context: bounded file changed, is unreadable or exceeds limit`. Original events and exact command receipts remain in the audit sidecar. The failure is historical; the same whole-file reader exists at source `5386bd5d6dedd84dd69760cfee4f1c0f19543f87`.

Priority: before routine BB continuation. Impact: valid current authority becomes unreadable as unrelated history grows. Total delayed time and tokens are notMeasured.

## Work to do

- Separate bounded current admission state from retained history and usage. Reuse the existing control boundary rather than adding per-run compaction wrappers.
- Publish the current projection atomically and validate its schema before launch. Preserve exact task, actor, scope, STOP, revocation and ended-grant semantics.
- Distinguish permanent malformed/oversized current state from temporary unavailability in dispatch; expose an actionable blocked state instead of an endless fixed retry.
- Keep history immutable and accessible when a review actually needs it.

## Out of scope

- Merely raising the file-size limit or periodically stripping whitespace.
- Relaxing permission, Stop, source or grant validation; deleting old evidence.

## Verification

- Append large history and change history formatting without changing current authority: admission has the same result and bounded bytes read.
- Revoke/stop the current grant during continuation: the next execution is denied even with an old launch snapshot.
- Missing, mismatched, malformed and oversized current projections give distinct bounded outcomes.
- Demonstrate the old whole-file failure with an isolated fixture; preserve original failure receipts.
