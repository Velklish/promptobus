# ADR-016: Cleaning up after one accepted piece is a verb of its own

**Status:** Accepted
**Date:** 2026-09-14
**Deciders:** the run's orchestrator, under the owner's decision of 2026-09-12 that sets the cleanup boundary, and the standing mandate of the same day to close the remaining forks in an ADR with the rejected options. **Not reviewed by the owner**: the line separates the owner's fixed boundary from the implementation decisions recorded here.

## Context

Everything the mechanism cleans up, it cleans up for a whole task. `done` closes the task,
stops the sessions, sweeps the worktrees of closed tasks, removes a branch it has proven
merged by two content measurements ([PB-6](../archive/PB-6-done-blames-conflict-after-squash/result.md),
[PB-158](../archive/PB-158-done-keeps-a-branch-it-proved-merged/result.md)) and finally
sweeps journals past a threshold. Per piece there was nothing: `dismiss` removes a watch
only, `stop` kills one session, and neither touches a directory. `engine.prune` **refuses on
an active task**, and at the moment one piece is accepted the task is active by definition.

What that left behind was measured on disk on 2026-09-12 rather than inferred: `artifacts/`,
`blobs/` and `files/` of an accepted piece stay until the whole journal is swept;
`workers/<stem>.settings.json` was removed by nobody, and a task closed on 2026-09-10 still
carried three reviewer settings files; seventeen mechanism directories stood in the
temporary root.

The owner's decision of 2026-09-12 sets the boundary. **The telemetry a strategy is built
from must survive.** The worktree and the branch of the accepted participant, the blobs and
files of that piece, and the temporary stands may go. Sessions are already stopped by `done`
and were not asked to move.

That boundary is not where the code drew it. `telemetry.jsonl` lives outside the store and
survives anything, while `health.json`, `supervisor.log`, `stalls.json`, `messages/` and the
`waits/` sidecars leave with the task directory.

## Options

**Decision 1 — the shape of the action.**

**1A — a verb of its own, `promptobus sweep <address>`.** One more command in the surface,
and its boundary against three neighbours has to be said out loud.

**1B — a flag on `done`.** Rejected on the precedent
[ADR-012](adr-012-stopping-one-participant-is-a-verb-of-its-own.md) set for the same shape:
`done` promises the whole task — it closes it, stops sessions, appends telemetry and prunes
journals — and a subset flag makes every one of those promises conditional on a flag the
reader has to notice. [ADR-013](adr-013-approver-is-a-fourth-addressed-participant.md)
records the same conclusion in advance.

**1C — relax `engine.prune` to work on an active task.** Rejected. Its refusal is not an
oversight: it wipes a task's correspondence and blobs whole, and the piece sweep must keep
most of that. Loosening the gate would put the widest deletion in the store one argument
away from a live run.

**Decision 2 — what the verb is called.**

**2A — `sweep`.** The word the codebase already uses for cleanup (`sweepWorktrees`,
`sweepParticipantSecrets`, `sweepJournals`, `sweepBindings`), so the verb and the functions
under it read as one thing.

**2B — `accept`.** Rejected. The acceptance decision is not the mechanism's to make — it
belongs to the approver, and the card that owns it says so. A verb named `accept` would
promise a judgement the command does not carry: all it can read is whether the work is
provably in the base, and that is a machine fact, not a verdict on the work.

**Decision 3 — who may call it, and how the right is established.**

**3A — the task mailbox owner, or an approver of this task holding its own recorded
session, each proven positively.** The proof is the session on the participant record, the
same one direct worker↔approver traffic is proven by (`requireDirectSender`).

**3B — the owner gate of `done`, `stop` and `dismiss`, reused as it stands.** Rejected, and
the reason is not the set of callers but the **direction of the default**. That gate reads
`ownership`, which answers `gated: false` — pass — when the task records no owner or the
call carries no session identity. For `done` that is a considered fail-open: its subject is
the owner's own run, and a run nobody owns has nobody to protect. For a piece sweep the same
default means any session naming `--task` may delete another participant's worktree, branch
and blobs out of a live task. The first draft of this command did exactly that, and its
suite closed on the bypass rather than on the refusal, which is worse than no check at all:
the bypass became the expected behaviour. Reused unchanged, it would also refuse the only
caller the verb exists for, since acceptance runs in the approver's session by ADR-013.

**3C — any participant of the task.** Rejected. The command removes a worktree, a branch and
blobs; a worker able to sweep a neighbour is a foreign hand on live work.

**Decision 4 — what "the files of the piece" means.**

**4A — the blobs the participant sent and their `files/` entries.** What the piece produced.

**4B — 4A plus `brief-<slug>.md` and `review-<slug>.diff`.** Rejected, and the boundary is
named here rather than left to be inferred. Those two are **evidence, not product**: the
brief says what the participant was asked to do, the diff says what the reviewer read, and
together they are why the piece was accepted. A cleanup that took them would leave the
acceptance decision without its grounds. The second reason is smaller and points the same
way: their stems live in exactly one place each (`lib/review.js`, `lib/spawn.js`), and a
cleanup module that knew them would be a third copy of a name those modules deliberately
keep single.

## Decision

**1A, 2A, 3A, 4A.** `promptobus sweep <address>` cleans up after one accepted piece and
leaves the task active.

- **It removes** the participant's worktree and the `worktree-` branch the mechanism
  created; the metadata records of the artifacts it sent, the `files/` entry of each, and
  the blob of each once no surviving record names it; its mcp-config, settings file and
  temporary stands in `workers/`; and its contact point under `wake/`.
- **The merge proof is the one `done` already uses and there is no third measurement.**
  `inspectWorktree` and `worktreeDisposition` decide, so "merged" means the same thing in
  both commands. A squash the base has since moved over is proven by `patch-id --stable`
  where `merge-tree` stops answering; both paths are covered by fixtures.
- **A piece whose merge is not provable keeps its tree — and its blobs and files with it.**
  One proof gates all three, because a tree that is not in the base and the artifacts
  describing it may each be the only copy of that work. The command says so in a warning
  line rather than removing them silently. The secrets in `workers/` still go: they are
  gated on the session being dead, not on the merge, exactly as in `done`.
- **A worktree the journal names and disk does not have is its own state.** Neither
  measurement can run on a directory that is not there, so nothing of that piece is judged
  taken and its blobs and files stay with the branch. It is not the same as a record that
  names no worktree at all — a reviewer — where there is nothing to prove and nothing to
  hold back. Reading the first as the second would destroy the only copy of work behind an
  unmerged branch whose tree somebody deleted by hand.
- **The harness state outside the worktree goes too.** The sweep calls the driver's own
  `sweepParticipant` for the dead session, as `done` does: a Codex participant keeps an
  isolated home with a copy of the owner's credentials, and it lives outside every directory
  the paths above name.
- **A session that is not dead refuses before anything is touched.** `git worktree remove`
  does not look at processes, and the directory would leave from under a running `cwd`. The
  refusal names `promptobus stop <address>` as the step before it. "Unknown" refuses on the
  same line as "alive": a record with no session reference cannot be told from a registry
  that did not answer.
- **The right is a positive proof, and every absence refuses.** No session identity, no
  recorded owner and no approver, a session that is neither — each is a refusal, not a pass.
  The gate is the command's own and deliberately not `ownership`; the reason is option 3B.
- **A closed task is refused, and an explicit `--task` is not a way in.** The command
  promises the task stays active and prints that line at the end; on a closed task the line
  would be a lie, and what is left of one belongs to `done` and `prune`.
- **Every removal target is proven before the first side effect.** A removal path is built
  from artifact-record fields, so every record of the task is validated against the schema
  and both derived paths must stay direct children of the task's own directories. A record
  this walk cannot read stops the whole sweep and is named: a piece does not leave on a
  guess, and a record met AFTER the tree is gone would throw with the work already removed.
- **The destructive stretch runs under the task journal lock.** `spawn` writes a participant
  record through that same lock, so a re-lift between the liveness check and the removals
  would put a new worktree under a walk taking the old one away. Under the lock the record
  and the liveness are read again and compared with the mark taken before it; a change
  refuses with nothing removed. The refusals are returned rather than thrown, because an
  exit from under the lock would leave the lock directory behind.
- **A blob leaves only when nothing holds it, and "nothing" is read twice** — the surviving
  records, and the hard-link count of the payload. `placeFile` links a `files/` entry before
  the record lands, so a sender caught between the two has a link and no record, and only
  the count sees it. This narrows the window rather than closing it: `send` and `sendSync`
  take no task lock, so a payload stashed but not yet linked is invisible to both readings.
  Closing that fully means locking the publication path, which is not this command's to
  change and is recorded as its own finding.
- **The keep list is a check, not a comment.** `keptPaths` names the journal, `messages/`,
  the mailboxes, `waits/`, `health.json`, `supervisor.log` and `stalls.json`; `keptBy`
  answers which of them a removal would land inside; the remover throws on a non-null
  answer. The list is **derived** rather than chosen — those are exactly what
  `recordTelemetry` reads at `done` to write a run's rows.
- **A blob still leaves only when nothing names it.** The engine's rule that blobs are never
  removed one by one is about dedup inside a task, and it is not broken: a payload a
  surviving record names stays, and a re-send writes it again.
- **A `files/` entry is addressed by the name the record carries and proven by its inode.**
  `sendSync` fills `filename` from the adapter's placement callback after the digest, so a
  second send of one payload is recorded under the numbered name that actually landed. The
  name alone could name a foreign file; the inode alone cannot separate two entries of one
  deduplicated blob. An entry whose inode does not match is left in place and named out
  loud.
- **The exit code is 0 for every lawful outcome, a kept tree included.** "Not provably
  merged" is a verdict, not a failure. It is 1 only when git refused a removal the
  disposition had already approved.

**The settings-file gap is closed in both places.** `workers/<stem>.settings.json` now
leaves with the mcp-config beside it — in the piece sweep, and in `sweepParticipantSecrets`
of `done` where the gap was measured.

## Consequences

- The surface gains one verb, and the help of all four states the boundary in one breath:
  `done` is the task, `sweep` is one accepted piece, `stop` is one session, `dismiss` is the
  watch.
- Disk stops growing with accepted work inside a live run — the case that produced the card.
  A run of six pieces no longer carries six worktree copies through to its close.
- **The keep list now has an owner and a cost.** Anything that later needs a task path to
  survive a piece sweep must be added to `keptPaths`, and anything added to
  `recordTelemetry`'s inputs must be added with it. The suite guards the pair by purpose: it
  closes the swept task and reads the telemetry row back, so a source removed from one side
  and not the other goes red rather than reading zero.
- **The gate is the first place in the CLI where a non-owner may change a task's files.** It
  is narrow — one role, proven by the participant record's own session — but it is a
  precedent, and a future role wanting the same must argue for it rather than inherit it.
- **Two gates now answer "who may" differently, and that is on purpose.** `done`, `stop` and
  `dismiss` keep the fail-open `ownership` gate; this command does not use it. Anyone reading
  one and assuming the other will be wrong, so the difference is stated in `03-cli` beside the
  command as well as here. A future command should decide its own direction rather than copy
  whichever neighbour it read first.
- **The destructive stretch holds the journal lock for the length of a `git worktree remove`.**
  Other writers of that task — a lift, a close, a title patch — wait for it. The alternative
  was leaving the re-lift race open, and a blocked journal write is recoverable where a
  worktree removed under a live session is not.
- Acceptance still cannot be proven by the mechanism, only cleanup after it. A sweep called
  on work nobody accepted will do exactly what it says: the machine facts are the session
  being dead and the merge being provable, and neither is a verdict on the work.
- **What this does not give:** a way to sweep a piece of somebody else's task, and a way to
  reclaim the journal of a live task. Both are deliberate.
