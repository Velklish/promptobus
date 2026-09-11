# PB-175 · A contact point file outlives its session, so liveness cannot be read from it

- **Order:** 110
- **Scope:** `tasks/<id>/wake/<address>.json` in the store, `lib/status.js`, the warden's
  contact-point handling
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Found 2026-09-12 by a worker that read the run's store to measure what gives the orchestrator
its identity. It counted live participants from `wake/<address>.json` and got the wrong answer,
then reported both the answer and the method that produced it.

**The file stays after the session behind it is gone.** In the run's store there were seven
contact points. Six were Claude Code sessions — socket `/tmp/cc-socks/<pid>.sock`, a token
present. The seventh belonged to a participant whose process had been killed some forty minutes
earlier; its file sat there unchanged, so a reader counting files counted it as live.

The shape itself is sound: `{address, socket, token, pid, session, at}`, one per address. The
defect is that nothing distinguishes "this session is reachable" from "this session was
reachable once", and the file's own name invites the first reading.

**Why it matters beyond one miscount.** The warden knocks on this contact point; `promptobus
status` reads around it; and a person debugging a silent participant looks here first. A stale
file makes all three of them confident about a session that is not there. The same class of
defect is recorded for the Codex registry in `PB-174`, where a manual stop leaves
`state: alive` behind — two files, one shape of lie.

## Work to do

- Decide what a reader is entitled to conclude from the file, and make it true: either the file
  is removed when its session ends, or it carries something a reader can check — the pid is
  already in it, and a dead pid is checkable without asking a harness.
- Whatever is chosen, `promptobus status` must not present a stale contact point as a live one.
- Record the rule where someone reading the store will find it, so the next reader does not
  repeat the miscount.

## Out of scope

- The warden's delivery itself: knocking on a dead socket already fails harmlessly, and the
  subject here is what a reader concludes, not what the warden does.
- `PB-174`'s registry record — same class, its own card.

## Verification

- Counting live participants from the store gives the same answer as counting live processes.
- A stale contact point is distinguishable from a live one without starting a session.
