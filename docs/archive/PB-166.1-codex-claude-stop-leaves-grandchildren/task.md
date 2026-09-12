# PB-166.1 · Two drivers reap a stopped participant's children and the Claude one does not, and nothing measured says whether it has to

- **Order:** 20
- **Scope:** `lib/driver-claude.js` (`stop`), [03-cli](../../reference/03-cli.md) § Status, done, dismiss, history, prune
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Finding discovered while working on PB-166, whose fourth bullet asks to establish whether a
killed participant session takes its children with it. The read-side answer is asymmetric,
and the asymmetry is the finding.

| Driver | What `stop` does about processes | Standing |
|---|---|---|
| Cursor | `stopSession` runs the harness command, waits for the session to vanish, then reaps: `treeOf(panePid)` + `killPids` for the turn's tool children, and `reapOrphans(marker)` for the `worker-server` | **closed, and on a measurement** — `cursor-persist.js` records that `agent persist stop` stops the pane in 0.14 s and leaves the turn's tool children alive (REPORT §4.8), and that an orphaned `worker-server` outlives even a normally finished turn by 11 minutes (§4.11) |
| Codex | `reapHolder` asks the holder to shut down and, on refusal, `process.kill(-pid, 'SIGKILL')` on both the holder and the app-server pid — a process GROUP kill, so descendants go | **closed by construction** |
| Claude | `stop` runs `claude stop <id>` and waits for the record to leave the registry (`awaitSessionGone`). It reads no process, walks no tree, signals no group | **unmeasured and unguarded** |

`promptobus done` stops every participant through `stopParticipant`, which dispatches to the
driver, so the table above is also the whole of what `done` does to processes.

So: for two harnesses out of three the question PB-166 asks is already answered and already
closed in this package. For Claude it is neither. If `claude stop` does not reap a session's
grandchildren, a stopped worker leaves them at `PPID 1` — the second orphan source PB-166
names, and it lives in this package's `stop`, not in a test file.

**Measured 2026-09-12, and the measurement moved the question out of `stop`.** The stand was
the one PB-166 asked for: a background Claude session lifted as a participant, a long-lived
process started from inside its turn with a mark of the stand's own in its command line, the
mark and never a program name as the scope, then `promptobus done` on the task. `done` closed
the session (`session of participant worker:stand closed: session 7154c2b7 closed`) and the
marked process was in `ps` before and after it, one occurrence each time. The "before" reading
is what makes the result readable at all — "nothing is left" is equally green on a stand that
never started anything.

**The columns are the finding, not the count.** `pid=30360 ppid=1 pgid=30358` in BOTH readings.
The process was already an orphan, in a process group of its own, before the stop: `nohup … &`
detached it and the short-lived tool shell died behind it. So neither shape this card proposed
would have reached it. A tree walk from the pid `claude agents --json` names finds nothing,
because the process is not in that tree. A `process.kill(-<session pid>)` finds nothing, because
the group is not the session's. Only the stand's own mark found it, and a mark is not something
the mechanism can put on a command a worker writes.

**The earlier reading in this card is corrected by that.** The process-group observation of the
same day — MCP servers and `caffeinate` in the session's group, the tool shell in its own —
stands as an observation, but the conclusion drawn from it, that the Cursor shape was therefore
the one that fits, does not: it was taken while no detached descendant existed to test it
against.

**What is open is not `stop`.** By the time any driver is asked to stop a session, a detached
descendant is outside every handle the record holds, and there is nothing left to walk. The
question is upstream: what the mechanism can use to delimit "the processes of this session" when
neither the tree nor the group holds them. One candidate — the session lifted into a process
group the mechanism creates, with the sweep run over that group — is a change to the LIFT, not
to `stop`, and carries its own cost; it belongs in a card of its own.

**The boundary of the stand, stated rather than assumed.** Its process was detached by `nohup`,
so the case of a descendant still ATTACHED at the moment of the stop is not covered by this run.
That such descendants exist is likely; that they are the common shape is not measured. A second
stand would start the process without `nohup` and in the foreground of the turn's shell.

**One live observation points this way, and its limits have to be stated with it.** Six
orphans found on the owner's machine 2026-09-12, at `PPID 1`, age 4 h 25 m, idle:
`node -e setInterval(()=>{},1000)`, `lsof` cwd `…/.claude/jobs/96726435/tmp/pb161/stand-trust`
and `…/T/pb161-trust-stand`. They are stub harness processes from a hand-built PB-161
measurement stand, and the session that raised them was a Claude Code job whose death took
nothing with it. That is a Claude session ENDING, which is not the same route as `claude stop`
on a lifted participant — so it does not answer this card, and it is not offered as its
evidence. What it does show is that the reparenting happens under this harness in practice,
so the stand below should cover both routes: a participant stopped through `done`, and a
session that simply dies.

## Work to do

- **Done — the stand ran, and it closes this card as a measurement rather than a fix.**
  `lib/driver-claude.js` `stop` is unchanged and should stay so: the stand showed there is
  nothing in `stop` to repair. The reference carries it — `docs/reference/03-cli.md`
  § Status, done… , commit `05cd49d`, which also withdraws the earlier "the Cursor shape is
  open to this driver" sentence in the same paragraph; CHANGELOG carries the same correction.
- **What the next card gets, in one line:** the six PB-161 orphans and this stand are the same
  shape seen twice — a descendant detached before anything tried to collect it. Whatever
  delimits a session's processes has to be put in place at the LIFT, because at the stop there
  is nothing left to read.
- Grandchild alive after the stop — the Claude driver gets a reap, and the shape is already
  written twice next door: the Cursor driver's tree walk for a pid the record names, or the
  Codex driver's group kill. Which one fits depends on what `claude stop` leaves and what
  the session record knows about its own pid.
- Grandchild gone — say so in the reference beside the other two, and this card closes as a
  measurement. The asymmetry then stops reading as a hole.

## Out of scope

- The Cursor and Codex reaps, which are measured and in place.
- The suite's own orphans, which are PB-166: this card is about a participant session, not
  about a test file.

## Verification

- The reference section on `done` names what each of the three drivers does about a stopped
  session's children, and names the stand for the Claude answer the way the Cursor and Codex
  measurements are named today.

## Cost

A paid Claude turn: a real background session has to be lifted and told to start something.
Schedule it where the owner's Claude window has room, the way PB-161.3 was scheduled.
