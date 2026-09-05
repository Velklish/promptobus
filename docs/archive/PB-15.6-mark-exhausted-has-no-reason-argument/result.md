# PB-15.6 · Result

**Closed 2026-09-05.** Completed. `markExhausted(host, harness, { resetAt, reason })`: the reason derived as before when absent, a value outside the two codes falling back to the derivation; the Claude driver's late-start mark goes through it (`subscription_exhausted` when the refusal said the limit resets, `manual_exhaustion` when it explained nothing — both sticky, the reference says why) and no longer writes entries directly. Track `routing`, same worker and review round.

**Verification.** The driver's exhaustion checks unchanged and green; probes: the argument dropped from the driver → the `subscription_exhausted` check red; the helper ignoring it → the cache check red. Gates re-run on the merged `main` tree by the approver.

**Documentation in the same pass.** `docs/reference/03-cli.md` § Availability (`markExhausted`), `CHANGELOG.md`.
