# PB-14.3 · Result

**Closed 2026-09-05.** Completed. `lib/model-routing/cache.js` holds a lock file `<cacheFile>.lock` across the read, the merge and the rename; another writer's lock is waited out for up to 2 s, one older than 15 s is broken as litter from a process that died mid-write, and a lock that cannot be taken is not a refusal — the write happens anyway, because a cache that refused to write would lose the entries the lock protects. `clearExhausted` takes the same lock. Track `routing`, same worker and review round.

**Verification.** Checks: a writer waits out a lock it did not take, breaks a stale one, releases what it took; four preflights on distinct stub harnesses in four processes told to write at one instant all land. Probe: the lock removed from `writeEntries` → both checks red, 3 runs of 3. Gates re-run on the merged `main` tree by the approver.

**Documentation in the same pass.** `docs/reference/03-cli.md` § Availability (the cache subsection), `CHANGELOG.md`.
