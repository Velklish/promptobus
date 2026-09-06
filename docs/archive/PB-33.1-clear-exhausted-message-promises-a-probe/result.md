# PB-33.1 · Result

**Closed 2026-09-06.** Completed by the approver before the tag. `models --clear-exhausted <harness>` now says what happens: "the exhaustion mark is cleared — the harness counts as unknown until the next --refresh probes it again". The behaviour was right (the clear drops the entry; `models`, `spawn` and `review` read the cache and probe only under `--refresh`); the sentence promised a probe nobody makes.

**Verification.** `npm test` 47/47 on `main`. No test pins the sentence; the finding's own measurement stands as the check.

**Documentation in the same pass.** Not required: the reference describes the clear without quoting the sentence.
