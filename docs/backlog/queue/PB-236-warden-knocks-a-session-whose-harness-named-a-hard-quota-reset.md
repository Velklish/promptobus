# PB-236 · The warden keeps knocking a session whose harness reported a hard quota limit with a reset date days away

- **Order:** 430
- **Scope:** [03-cli § Guard and warden](../../reference/03-cli.md#guard-and-warden)
- **Created:** 2026-09-17
- **Dependencies:** none

## Context

The warden knocks a participant with unread mail until it answers. When the harness answers
every knock with a quota refusal naming a reset date, the knocking does not stop and nothing
in the run's own output says the participant is unreachable rather than busy.

Measured on 2026-09-17. Over roughly six minutes the journal recorded knocks 54 through 155 at
a steady two-second cadence, each one rewriting the contact point, interleaved with the
harness's refusal:

```
13:54:51 notification reviewer:<slug>: unread 2, knock 154 (contact point rewritten)
13:54:53 <harness>: last turn failed: You've hit your usage limit. … try again at
         Sep 19th, 2026 12:15 PM.
13:54:53 notification reviewer:<slug>: unread 2, knock 155 (contact point rewritten)
```

The cost is not the knocking. It is what `status` says while it happens:

```
session "…" is alive (the turn is running · last event item/completed 1 s ago)
```

That line is true and misleading together. A turn is running — the one the knock just started,
which will fail in two seconds like the hundred before it. An orchestrator reading `status`
sees a working participant and waits. The run here lost several minutes to exactly that: the
stall was first read as a slow round, then as a transient failure ("the thread is still up and
a later turn may succeed" — which is the right hint for a crash and the wrong one for a quota
with a date on it), and the true state was only visible by reading the journal by hand and
noticing the knock counter.

The distinguishing fact is already in the harness's own words and is already reaching the
journal: a reset **date**. A failure carrying one is not transient, and the reset date is
usually far outside any run.

## Work to do

- Treat a harness refusal that names a reset time as a state, not as one more failed turn:
  stop knocking that address until the named time, and say in `status` that the participant is
  unreachable until then rather than that a turn is running.
- Report it once to the orchestrator when it is first seen, with the reset time, so the run can
  make its decision — replace the participant, split the work, or stop — instead of discovering
  it by reading the journal.
- Leave failures without a named reset alone: for those, retrying is the right behaviour and
  "a later turn may succeed" is the right hint.

## Out of scope

- Replacing the unreachable participant. That is the binding problem and is filed separately.
- Parsing every harness's error text into a taxonomy. Only one fact is needed here: whether the
  refusal names a time to retry after.

## Verification

- A participant whose harness names a reset time is knocked at most once more after it is seen,
  and `status` shows it as unreachable until that time.
- The orchestrator receives one report naming the time, not a silent change of behaviour.
- A failure with no named reset still retries as it does now.
