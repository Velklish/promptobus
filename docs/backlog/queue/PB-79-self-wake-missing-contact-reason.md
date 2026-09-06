# PB-79 · The self-wake fallback for a vanished contact point is gated on channel alone, so once self-wake is already set it writes nothing and status keeps citing a knock error from a socket that no longer exists

- **Order:** 530
- **Scope:** [reference/03-cli](../../reference/03-cli.md) § Guard and warden, `src/supervisor.ts`, `lib/status.js`
- **Created:** 2026-09-06
- **Dependencies:** PB-64

## Context

`src/supervisor.ts:561-562` starts every round from `const h: HealthMark = { ...was }`, so a field the current branch does not touch keeps its previous value. The no-contact-point branch, `src/supervisor.ts:659-666`:
```
} else if (!endpoint?.socket) {
  // There is no contact point — nothing to knock with, and this is not
  // held back by the threshold: the participant can hand over the
  // channel after the message has already landed.
  if (h.channel !== 'self-wake') {
    h.channel = 'self-wake';
    h.wake = null;
    events.push(`fell back to self-wake ${addr}: no contact point — the participant did not hand over a socket`);
  }
}
```
compares `h.channel` only. Its two siblings compare the reason as well: the taken-by-another-session branch at `:677` (`if (h.channel !== 'self-wake' || h.knockError !== why)`) and the refused-knock branch at `:727` (identical shape). So the first time this branch fires from a healthy channel it behaves like its siblings — event logged, `h.wake = null`. But once a *different* branch has already set `h.channel = 'self-wake'` with some `h.knockError` (for example the refused-knock branch, which the existing test at `test/promptobus-warden.test.mjs:292` drives to `knockError: 'ENOENT'`), and the contact point then disappears entirely (the socket file is removed, `readWake` returns null), this branch runs again with `was.channel` already `'self-wake'`: the guard `h.channel !== 'self-wake'` is `false`, so the whole body — the event push, `h.wake = null` — never executes. `h` stays byte-identical to `was` for this participant, `changed` is never set from this branch (`src/supervisor.ts:744`), and the round writes nothing: no warden-log line, `h.knockError` still names the old socket error, `h.wake` still names the fingerprint of a socket that is gone.

`lib/status.js:128` prints `alarm: self-wake${h.knockError ? ` (reason: ${h.knockError})` : ''}` — so a reader is told the account or channel refused a knock (e.g. `ENOENT`) when the actual, current fact is that the participant has no contact point at all, a different diagnosis with a different fix. `lib/status.js:93` documents the general stickiness (`knockError is sticky: it resets only on a successful knock`) and lines `98-103` compensate for it only in the orchestrator's own dead-process case — nothing compensates for it here.

## Work to do

- Give this branch the same reason comparison as its two siblings: introduce a fixed reason string (e.g. `no contact point — the participant did not hand over a socket`), gate the block on `h.channel !== 'self-wake' || h.knockError !== why`, and inside it set `h.channel`, `h.knockError = why` and `h.wake = null` unconditionally, so the transition from "a channel refused" to "there is nothing to knock on" is journalled once and status reads the current reason.
- Add a case to `test/promptobus-warden.test.mjs` next to the existing self-wake fallback tests (around line 267 and 292): drive a refused knock to `knockError: 'ENOENT'` as the existing test does, then remove the registered contact point and run another round past `KNOCK_RETRY_SEC` — assert the round's `events` contain the no-contact-point fallback line and that health now carries the no-contact-point reason with `wake === null`, not the stale `ENOENT`.

## Out of scope

- The other two branches' reason comparison and the delivery/new-message reset paths (`src/supervisor.ts:566-596`) — they already compare or clear the reason correctly; only the no-contact-point branch is missing the check.

## Verification

- `npm test` passes, including the new case in `test/promptobus-warden.test.mjs`.
- Manually: refuse a knock (health becomes `self-wake`/`knockError: <error>`), remove the registered contact point, run another warden round past the retry threshold — the round's events include a fresh `fell back to self-wake` line and `health().<addr>.knockError` no longer names the old error.

## Triage — 2026-09-07

- **Track:** W — Guard and warden delivery.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `src/supervisor.ts:561`, `test/promptobus-warden.test.mjs:292`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
