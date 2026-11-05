# PB-422 · The serial group takes half of npm test; find which fixed pauses inside promptobus-e2e and promptobus-mixed can be shortened

- **Scope:** [Suite isolation](../../guides/contributing.md#suite-isolation)
- **Created:** 2026-11-05
- **Dependencies:** none
- **Cost:** minor

## Context

The serial group runs its nine files one by one after the pool, so every second of it is a second of the run. It took 232.6 s of a 486.4 s `npm test`: `promptobus-e2e` 70.9 s, `promptobus-mixed` 51.8 s, `live-mixed-stand` 45.1 s, `runner` 17.6 s, `promptobus-cursor-wake` 15.1 s, `cursor-stop-bounded` 13.0 s, the other three 19.1 s together.

Evidence: 2026-11-05 on `4acbb783`, eight cores. Each serial file run standalone with a preload that stamps every stdout write: `promptobus-e2e` spends 12.5 s before "step 5: the worker fetched the mailbox on the knock", 14.2 s before "step 6: the reviewer sent notes", 12.8 s before "step 7: the worker closed the note" and 10.5 s before "step 8: the warden wrote the stall into the log"; `promptobus-mixed` spends 18.1 s before "step 7: the worker's last send is not older than its last activation" and 10.2 s before "step 6: the reviewer sent notes". The file header of `promptobus-e2e` names one wait — the warden heartbeat `WARDEN_BEAT_SEC`, 30 s — but the pauses are spread across the steps, and which of them are a fixed tick and which are honest work is not established.

Next step: attribute each pause of more than 5 s to its cause — a stub turn, a warden tick, the heartbeat, a poll interval — and decide per cause whether a test-only setting may shorten it without weakening the wall-clock verdicts the group exists for.

## Work to do

- Attribute the pauses and propose the changes with their expected saving.

## Out of scope

- Moving files out of the serial group.

## Verification

- Standalone stamps before and after, and the serial group's time in a full run.
