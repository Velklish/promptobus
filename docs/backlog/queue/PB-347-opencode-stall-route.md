# PB-347 · A stalled opencode participant crashes status and the warden because stallRoute is missing

- **Order:** 60
- **Scope:** [05. Drivers — OPENCODE](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** none
- **Cost:** major

## Context

The OpenCode driver advertises inspection and wake support but implements no `stallRoute`. The shared `stallRouteOf` dispatcher calls that method unconditionally when rendering a stalled participant. This throws instead of producing the recovery instructions used by status and the warden.

Evidence: 2026-10-06, commit `8c56183b5f99b179a03f39a09da929acfc3382ef`, Node v25.2.1. From the repository root:

```sh
node --input-type=module -e 'import { stallRouteOf } from "./lib/drivers.js"; console.log(stallRouteOf({harness:"opencode",kind:"unknown",address:"worker:audit",id:"ses_audit"}, "audit-opencode"));'
```

Exit code: 1. The exception is `TypeError: driver.stallRoute is not a function` at `lib/drivers.js:116:17`. The driver object at `lib/driver-opencode.js:508` contains no such method. A local OpenCode run's warden journal also records `watch round failed (1/3): driver.stallRoute is not a function` on 2026-10-06.

## Work to do

- [ ] Define and implement OpenCode recovery instructions for the stall kinds emitted by its inspector.
- [ ] Cover the shared dispatcher and an OpenCode participant in the status/warden path; asserting only the driver object would miss the integration failure.
- [ ] Update the driver reference with the measured recovery behavior.

## Out of scope

- OpenCode root ownership and model routing.
- Changing recovery instructions for other harnesses.

## Verification

- [ ] The reproduction returns a recovery instruction with exit code 0.
- [ ] A stalled OpenCode participant does not throw from status or a warden reporting round.
- [ ] Relevant driver and warden tests pass; the new test fails when the OpenCode stall method is removed.
