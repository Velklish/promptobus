# PB-166.1 · Result

**Closed as a measurement that moved the question out of `stop`.** The owner ran the stand:
`promptobus done` closed the session and the marked process was in `ps` before and after it,
`ppid=1 pgid=30358` in both readings — already an orphan in a group of its own before the stop.
Neither shape the card proposed would have reached it: a tree walk from the pid the registry
names finds nothing outside that tree, a group kill finds nothing outside that group. `stop` is
therefore not where the fix goes; what is open is upstream, how the mechanism delimits a
session's processes at all, and that is a change to the lift.

Verified: the stand's own before/after readings, quoted in the card; the read-only process-group
measurement that preceded them; and the boundary stated with both — the stand's process was
detached by `nohup`, so a descendant still attached at the moment of the stop is not covered.

Outside the card: the upstream question, and the earlier conclusion that the Cursor shape fitted
— withdrawn by this measurement rather than quietly dropped.

---
