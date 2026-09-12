# PB-186 · Result

**Closed on both sides, and the question the card put was answered rather than worked around: the
product permits the race deliberately and conditionally, and the test asserted a guarantee the
product never gave.** The answer is in `withCacheLock`'s own header, not in a guess — "A lock that
cannot be taken is not a refusal… the write happens either way — at worst the behaviour is what it
was before the lock existed, for the one run that timed out". So the real guarantee is: no entry is
lost **while every writer takes the lock**; a writer that waits past `LOCK_WAIT_MS` writes unlocked
and may lose a neighbour. A holder keeps the lock for one read and one rename, which is why four
writers serialise on an idle machine and why one of them can miss the deadline at load ≈ 40.

**So the defect is not the race — it is the race's silence.** A write that fell through the lock
was indistinguishable from one that held it, and the entry it overwrote vanished without a word.
`withCacheLock` now tells `body` whether it held the lock, `writeEntries` returns `contended`
beside `doc` and `dropped`, and `preflight` warns next to the warning it already had for `dropped`.
Existing seams, no new abstraction.

The test stops asserting the unconditional form, which is what made its verdict move with the
machine. It reads the precondition off the run: no child reported a fallthrough, so the strong
assertion — all four entries land — stands exactly as it was; a child did, so the loss must be
**named** and the document readable. That is not a sleep: under contention it asserts something
else, and something true. Beside it a deterministic counterpart, where the test holds the lock
itself past `LOCK_WAIT_MS`, so the fallthrough happens by construction rather than by luck.

**Verified**: `node test/model-routing-preflight.test.mjs` exit 0, 36/36 (was 35). Mutation probes
on the warning, in two forms because one proves less than the pair: removing the warning's text
reddens the deterministic check with the text quoted back; forcing `cache.js` to report the lock
always held reddens the same check with an **empty** warnings list — the first shows the check
reads the text, the second that the whole reporting path is dead. Both returned to green.

**Outside the card**: the original reddening was not reproduced. Shortening the wait to zero leaves
the file green, because `waitFor` reads once before it checks the deadline and on an idle machine
the file is already there; load was not manufactured on a machine shared with other workers. The
mechanism rests on the recorded decision in the code and on the deterministic probe. Also outside:
the scope was widened to `lib/model-routing/cache.js`, where the lock lives and which the card does
not name — cleared with the approver before the edit rather than reported after it.

---
