# PB-183 · Result

**Closed 2026-09-12, completed.** The kind was removed and its sentence moved into a verdict that
actually fires.

Nothing in production produced `kind === 'question'`: `inspect` returns
`gone | stale | watchdog | failed | unknown`, and the only source was a fixture — a human-visible
route reachable only from the stand, where a check on it is green independently of the product. The
branch is gone and its instruction moved into the `watchdog` verdict, which fires on exactly that
silence: it now names a held dialogue as a cause, says to press Escape, and **drops the promise
that "the message will arrive on the next turn"** — a second falsehood in the same text, found
while moving it and asked for by nobody.

**Verification.** `promptobus-driver-cursor` 119/119; `npm test` 62/62 files on the merged tree.
The second half — the stand — arrived from a neighbouring branch and is present in the merged tree:
`test/harness-cursor.mjs:930` is `if (plan.askQuestion) return 'hang'`, so the fixture moved from
its own short path onto the PRODUCTION one (`inspect` → `watchdog`), which is what the card
required; `kind === 'question'` is absent from the driver.

**Documentation in the same pass.** The driver reference and the verdict text carry the change.

**Rejected option, with its price.** Teaching `inspect` to return `question` by reading the panel
was rejected: it would put a panel read into every liveness check for a state already established
by three numbers.
