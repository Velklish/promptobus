# PB-175 · Result

**Closed by fixing the reader, and both obvious ways to read the file turned out to be wrong.**
`status` now marks a line it cannot vouch for — `— STALE: the socket it names is gone` — and the
check is the socket **path**, not the `pid` and not the raw address.

Verified on a live store of nine contact points: eight named a pid that was already `ESRCH`, and
five of those eight belonged to sessions that were demonstrably alive, so the card's proposed
check would have called almost every live participant dead — `writeWake` stores `process.pid` of
whatever wrote the file, which for a Claude participant is the Stop hook that exits at once. The
socket separates them, but only read as a path: a Codex address carries a `#<n>` thread suffix on
one socket file, and `existsSync` over the whole address called both live Codex reviewers gone,
while the path before the `#` split all nine correctly and named as gone exactly the participant
whose process had been killed. Mutation probes on a committed tree redden the suffix rule and the
"no socket is not stale" rule separately.

Also fixed in passing, and named rather than smuggled: `orchestratorSocketGone` had been checking
the raw address and was right only because that participant is never Codex.

Outside the card: `PB-174`'s registry record — same family, different cure, because a contact
point has an externally checkable sign beside it and a registry record has none.

---
