# PB-168 · `promptobus status` prints one `self-wake` label over three states whose prognosis differs

- **Order:** 60
- **Scope:** `lib/status.js` (the alarm line), `dist/supervisor.js` (the three fallback branches)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Recorded in the consumer's tracker as `BL-631.1` (ati-agents, 2026-09-10) with the note "the
change belongs in the promptobus package; the mechanism is a consumer, the repin follows".
Moved here on 2026-09-12 so the release can carry it. The consumer's copy is archived.

The warden enters `self-wake` from three different branches (`dist/supervisor.js`, lines 655,
671, 736):

1. `no contact point — the participant did not hand over a socket` — the socket is not in yet;
2. `contact point is held by session <id>, while the address is bound to <id>` — another
   session took the contact point;
3. a raw driver error — the channel refused the notification. The phrase `<channel> did not
   accept the notification` goes to the journal only; `knockError` carries `r.error` verbatim.

`lib/status.js:142` prints all three as `alarm: self-wake`, plus `(reason: <knockError>)` when
one exists. **The reason is therefore already in the output** — the finding's original wording
("one label over two states") was wrong about that. Two things genuinely are not distinguished:

- **the prognosis.** State 1 clears itself on the warden's first knock; states 2 and 3 do not.
  The line says nothing about which, so a reader of `promptobus status` cannot tell waiting
  from fixing. Live case: the orchestrator of the 2026-09-10 run read the start-up label on its
  own address as a broken channel;
- **the channel name in state 3.** The journal names it (`socket` for Claude Code, `inject` for
  Cursor, `rpc` for Codex); `status` keeps the raw error without it. The `!wake?.socket` branch
  in the same condition also yields a bare `alarm: self-wake` with no parenthesis at all when
  `knockError` is empty.

That state 1 clears itself is verified from a run journal
(`.promptobus/tasks/da-scope-t20260910-185436/supervisor.log`): `fell back to self-wake
orchestrator` at 18:55:17, `notification orchestrator: unread 1, knock 1 (contact point
rewritten)` at 18:57:34, then `"channel": "socket"` and `"knockError": null` in `health.json`.
That states 2 and 3 do **not** clear themselves is read from the code and was never measured.

## Work to do

- Decide how the prognosis is carried: a separate label for the start-up state (socket not
  handed over yet), or a qualifier inside the same line.
- Decide whether state 3 should name the channel the way the journal names it.
- Whichever way it goes, the check must fail on the conflation, not on the string.

## Out of scope

- The orchestration skill's wording — that was `BL-631` in the consumer, already closed there.
- The warden's behaviour: three fallback branches are legitimate; only their display is the
  subject.

## Verification

- The start-up state is distinguishable from a broken channel without reading the journal.
- Tasks already on disk with an older `health.json` still read without an error.
