# PB-15.7 · Result

**Closed 2026-09-05.** Completed by the approver. The Claude adapter's event-loop check counts ticks of a 20 ms interval (`ticks >= 5`) like the Cursor and Codex checks instead of asserting a wall-clock threshold that measured the machine's neighbours in the pool.

**Verification.** `test/model-routing-adapter-claude.test.mjs` 23/23; probe, commit-first: the loop blocked (`Atomics.wait`) for the whole of the child's run, right after `spawn` → red with the interval ticking once. Measured limit of the shape, the same as its two neighbours: a PARTIAL block (600 ms of a ~2.7 s probe) stays green, because ticks are counted over the whole probe rather than the largest gap between them — the largest gap is exactly what pool load moves, and that trade is the reason for this task. Gates re-run on `main` by the approver.

**Documentation in the same pass.** The check's own comment; nothing else required.
