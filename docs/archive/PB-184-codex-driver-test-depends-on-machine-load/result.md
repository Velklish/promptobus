# PB-184 · Result

**Closed by removing the race, with the residual failure made honest.** A thread file is written
by the stand's holder, a separate process, and seven places read it once with
`try { JSON.parse(readFileSync(…)) } catch { null }`. Under load the reader wins, the value is
`null`, and the check reports the product wrong — **the different counters of the two failures
are different reads won at different points**, which is why no two matched and which is the
signature to recognise. The file already used `waitFor` for one such read; this is that idiom
applied to the six that lacked it.

Verified: `node test/promptobus-driver-codex.test.mjs` exit 0, 186/186 — the counter the card
records for an idle machine; and an end-to-end probe with the thread directory pointed at a
missing path, where four failure details carry
`TIMEOUT after 15000 ms waiting for <file> — the stand had not written the thread; this says
nothing about the product`.

**What was not shown:** the original reddening was not reproduced. Shortening the wait to zero
leaves the file green, because `waitFor` reads once before checking the deadline and on an idle
machine the file is already there; load was not manufactured on a shared machine. The mechanism
rests on reading the code and on the timeout probe.

Outside the card: the marker reaches four of the eighteen checks that fail when no thread file
appears; carrying it into the rest is its own pass. And the budget is arithmetic, not a
measurement — nine reads, 135 s if every one expires, under the 240 s watchdog and the 300 s
runner deadline.

---
