# PB-216.1 · Result

**Closed 2026-09-16 at triage, by measurement — the rule was already written by `PB-213`.**

The card asked for the loop guard to hold a turn that ends after a handover record was sent and no `result` followed, the same way it holds one for a gate record. `lib/guard.js` on `main` already does exactly that: the record check reads `isGateRecordName(name) || isHandoverRecordName(name)` (commit `1023f5e`, "PB-213: the handover record proves a green run means something", 2026-09-16), and the hold's reason line is the shared "a record artifact was sent and the turn is ending with no result".

**Evidence.** `git log -S isHandoverRecordName -- lib/guard.js` → `1023f5e`. The test sits next to the gate-record hold test, as the card asked: `test/promptobus-spawn.test.mjs`, checks "PB-213: a handover-record artifact without a result blocks the turn too" and "PB-213: and the result releases it, the same way the gate record's does", both green in the suite run recorded at the `PB-188` acceptance (`5a7b306`: `npm test` exit 0, 69/69 files, 2234/2234 harness checks).

**Nothing left open.** The card was filed from the `PB-216` result before `PB-213` landed on the same day; no code or documentation change is needed.
