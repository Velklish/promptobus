# PB-15.7 · Result

**Closed 2026-09-05.** Completed by the approver. The Claude adapter's event-loop check counts ticks of a 20 ms interval (`ticks >= 5`) like the Cursor and Codex checks instead of asserting a wall-clock threshold that measured the machine's neighbours in the pool.

**Verification.** `test/model-routing-adapter-claude.test.mjs` 23/23; probe, commit-first: the probe made to block the loop for 400 ms (`Atomics.wait`) → red with the interval ticking once. Gates re-run on `main` by the approver.

**Documentation in the same pass.** The check's own comment; nothing else required.
