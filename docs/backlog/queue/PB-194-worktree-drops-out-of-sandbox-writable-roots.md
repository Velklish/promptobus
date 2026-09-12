# PB-194 · A live participant lost write to its own worktree mid-session while $TMPDIR stayed writable

- **Order:** 10
- **Scope:** [drivers](../../reference/05-drivers.md)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

A Codex worker of run `beklog-0912c` wrote eight files into its own worktree, then four minutes
later could not write anything there at all. Nothing on the host changed: the files stay
`-rw-r--r-- kim.p staff` and the directory `drwxr-xr-x`, and the orchestrator wrote and committed
in that same worktree in the same minutes.

Measured from inside the participant, all on `codex-cli 0.146.0`, sandbox `workspace-write`,
`approvalPolicy: on-request`:

```
pwd                                   → …/.claude/worktrees/promptobus-beklog-0912c-pamyat-…
git rev-parse --show-toplevel         → the same path
test -w .                             → 1
test -w CHANGELOG.md                  → 1
printf '' >> docs/reference/05-sync.md → zsh: operation not permitted, 1
echo "$TMPDIR"                        → /var/folders/t8/…/T/
touch "$TMPDIR/pb-probe"              → 0
touch /tmp/pb-probe-pamyat            → 0
```

Last successful write into the worktree: six files at one `mtime`, 18:16:38 local. First refusal:
18:19:30. The session was never resumed — the mechanism has no resume path; the holder held the
thread throughout.

The discrimination matters and is already done: **`$TMPDIR` and `/tmp` stayed writable**. So the
sandbox did not flip to `read-only` as a mode — the declared worktree left the writable-roots set
while the rest of the policy stayed in force. A mode flip and a lost root are different defects and
would be fixed in different places, which is why the probe was run before any hypothesis.

Cost on the day: the worker could not commit either — `git` writes to the worktree too — so the
orchestrator inserted the worker's `CHANGELOG` text and committed nine files on its behalf
(`73b83f6e` in the consumer repo). That is a workaround, not a fix, and it does not scale: a
participant that cannot write cannot take another card.

Escalation is not an answer here and must not be proposed as one: see [PB-191](PB-191-apply-patch-never-passes-containment.md) —
`item/fileChange/requestApproval` of this generation carries no path, so containment fails closed on
every escalated write. Twelve such refusals are in the run's journal.

## A hypothesis the consumer's tracker raised the same evening

The consumer repository's own tracker holds a class of refusals with the same shape: `listen EPERM` and
`EPERM mkdtemp` inside a participant, on a tree where the orchestrator has neither refusal in the same
minute. With this card that is three `EPERM`s of the same kind. If they are one phenomenon, the subject
is not "`mkdtemp` and `listen` are special" but "the participant's sandbox narrows during the session",
and the class closes by finding what narrows it rather than by reading those two calls.

This is a hypothesis, and the cheap way to break it comes first: run `mkdtemp` and `listen` inside a
participant **twice** — at the start of the session and after the first write refusal. If `mkdtemp`
already refused while writes still worked, the two are independent and this paragraph goes.

## Work to do

- Establish what removes the worktree from the writable roots of a live thread. The candidates are
  the holder's `runtimeWorkspaceRoots`, the per-turn policy the binary derives, and anything that
  re-derives the root from a path spelling rather than from the resolved path. Name the one that
  measurement supports and say how the others were excluded.
- Give the participant a way to find out: a write refusal inside its own worktree must be
  distinguishable from an ordinary permission error, because the participant currently reports
  "the worktree is read-only" and cannot tell which of the two it is.
- Decide whether the mechanism detects the state and relifts, or refuses the participant loudly.
  A worker that silently loses its tree spends a whole card's worth of turns before saying so.

## Out of scope

- The escalation path — that is PB-191.
- The `apply_patch` tool's own behaviour when the sandbox allows the write.

## Verification

- A reproduction that takes a live participant from writing to not writing without touching the
  host, with `$TMPDIR` still writable at the end — the two probes above run in one command.
- A red check that fails while the defect stands, and a mutation probe showing the check is aimed
  at the writable-roots decision and not at a mode flag.
