# PB-228 · test/promptobus-mixed.test.mjs went red once under measured sibling-worker load, not reproduced on base

- **Scope:** `test/promptobus-mixed.test.mjs`, `test/home.mjs` (watchdog/serial-group placement)
- **Created:** 2026-09-17
- **Dependencies:** none

## Context

One `npx github:Velklish/backslop#v0.8.0 gates` attempt on branch sha `893d2d4c2b38b428617cc998b8379afaf2f9457d` (T8, PB-118/PB-120/PB-81/PB-212/PB-127/PB-139 hygiene track) hit `npm test` exit 1. The failure was inside `test/promptobus-mixed.test.mjs`, an E2E orchestration file this branch neither imports nor otherwise exercises beyond an ordinary `done()` call at its own step 13 (which passed): two checks at "step 7" went red, then the file's own 240 s watchdog aborted it.

Verbatim from the run:
```
✖ step 7: the worker closed the note and sent a second result — null · trace for worker:e2e: [{"at":"2026-09-16T22:31:54.923Z","kind":"turn-end","turn":0,"outcome":"done"},{"at":"2026-09-16T22:31:57.808Z","kind":"turn-start","turn":1,"text":"Promptobus service wake. The mailbox for address worker:e2e on task e2ebus-t20260901-000000 has unread: 1.\n\n— answer fro"},{"at":"2026-09-16T22:31:57.936Z","kind":"tool","tool":"promptobus_mailbox","isError":false,"text":"messages 1: answer from orchestrator · PROMPTOBUS_HOME=/private/var/folders/t8/8c_15_yx4hzdw8_wt5_15bb00000gn/T/promptobus-test-run-9FSvhA/promptobus-promptobus-mixed-MRfVfQ/ws/.promptobus · task=e2ebus-t20260901-000000 \"E2E orchestration loop\" · address=worker:e2e\n\n### answer from the orchestrator · address orchestrator · 2026-09-16T22:31:55.848Z\nE2E-ANSWER-1: правь только e2e/note.md"},{"at":"2026-09-16T22:31:59.437Z","kind":"wait","ms":1500},{"at":"2026-09-16T22:31:59.438Z","kind":"write","path":"e2e/note.md"},{"at":"2026-09-16T22:31:59.485Z","kind":"commit","status":"0/0"},{"at":"2026-09-16T22:31:59.490Z","kind":"tool","tool":"promptobus_send","isError":false,"text":"sent result → orchestrator · address orchestrator · id 20260916T223159486-0001-712c83 · PROMPTOBUS_HOME=/private/var/folders/t8/8c_15_yx4hzdw8_wt5_15bb00000gn/T/promptobus-test-run-9FSvhA/promptobus-promptobus-mixed-MRfVfQ/ws/.promptobus · task=e2ebus-t20260901-000000 \"E2E orchestration loop\" · address=worker:e2e"},{"at":"2026-09-16T22:31:59.495Z","kind":"turn-end","turn":1,"outcome":"done"}] · tmux panes: []
✖ step 7: a participant that finished a turn AFTER a send is not counted as stalled — turn yielded: null · snapshot {"state":"stale","busy":false,"stall":{"kind":"stale","reason":"persist session cursor-promptobus-e2e-t20260901-000000-2267ab2a35-1-f136a4 is not on the tmux server cursor-agent — it was stopped from outside or the machine rebooted"},"id":"cursor-promptobus-e2e-t20260901-000000-2267ab2a35-1-f136a4","note":"chat 7db32724-a395-476f-a63e-6a44073dd99c"} · predicate true
✖ watchdog: still alive 240 s after start, and the event loop is not empty. Either the work is not done — then this file needs splitting, the serial group, or a larger WATCHDOG_MS in test/home.mjs — or the work IS done and something holds the loop open, in which case the file would outlive the session that started it.
  what holds the loop: PipeWrap, ProcessWrap, Timeout
29/31 passed before abort
```

At the time, `uptime` read load averages `11.36 6.53 6.04` on an 8-core machine, and `ps aux` showed two other worker worktrees (`promptobus-run-0916-t10-...`, `-t11-...`) each running their own full `npm test` concurrently on the same machine — a different parallel workspace run (backslop track T10/T11), not anything this branch started.

Investigated before filing rather than waved away:
- `node test/promptobus-mixed.test.mjs` standalone on branch `893d2d4`, twice: exit 0, 48/48 both times (~38–42 s total each); both step-7 checks passed both times.
- The identical file on base commit `1946b15e965f6cdc99357ef45f7e0955cf46c3ef` (fresh worktree, `npm ci` + `backslop init`): exit 0, 48/48 — same timing profile. The "notes to the worker and second result" step measured 22.3–22.5 s in every one of the three runs (branch ×2, base ×1) — the same shape, not something the branch changed.
- A second full `npx backslop gates` attempt on the same branch sha `893d2d4`, ~5 minutes later once load eased to `6.06 7.00 6.48`: exit 0, `gates 4, green 4`.
- Matching load was not reproduced on the base commit on demand — this is why the finding is filed rather than the red being claimed as proven-environmental in the handover record for that task.

**In the branch's favor, named explicitly:** the send path this branch's commits touch is behaviorally identical to base on the relevant question — `src/v1/engine.ts`'s `finish()` lost its unread `meta` parameter (PB-139), a signature simplification with the same two call sites and the same message bodies, not a behavior change to what gets sent or when. None of this branch's commits touch stall accounting (`kind:"stale"`, the tmux-liveness check `promptobus-mixed.test.mjs` step 7 exercises) at all.

## Work to do

- Decide whether `test/promptobus-mixed.test.mjs`'s two step-7 checks and/or its 240 s watchdog need a wider margin under measured multi-worker load, following the shape `test/run.mjs`'s own "who is not in the serial group, and why" section already documents for other files (PB-159.1's class of finding).
- Reproduce with matching load if possible (e.g., start N sibling `npm test` runs deliberately, then run this file) to get an actual red-on-base data point one way or the other.

## Out of scope

- Treating a second red here as further proof of the same story without investigation — a repeat deserves its own look, not a second write-off citing this card.
- Any change to `promptobus-mixed.test.mjs`'s subject matter (the E2E scenario itself) — this card is about wall-clock margin only.

## Verification

- Whatever margin or serial-group change is chosen: the same file, run standalone and under a reproduced multi-worker load, passes both times.
