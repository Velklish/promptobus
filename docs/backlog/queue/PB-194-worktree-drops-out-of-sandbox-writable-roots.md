# PB-194 · A participant worktree is not shell-writable from the first minute while temporary directories are writable

- **Order:** 10
- **Scope:** [drivers](../../reference/05-drivers.md), the Codex participant sandbox boundary
- **Created:** 2026-09-12
- **Dependencies:** PB-191 for the file-change approval method

## Context

The earlier claim said that a live participant lost write access to its own worktree in the middle
of a session. That claim is rejected. It came from a participant report and an MTIME difference,
not from a probe run inside the participant at the time of refusal.

The inside measurement instead shows that the shell cannot write the participant's worktree from
the first minute. This is not a transition observed mid-session.

## Measurement from inside the participant

Measured on codex-cli 0.146.0, from the participant's own worktree, at
`2026-09-12T16:11:43Z`:

```
test -w .                                      -> rc=1
node mkdtemp with a relative prefix             -> EPERM: operation not permitted
node mkdtemp in os.tmpdir()                     -> /var/folders/.../T/pb-probe-3F4sOn, rc=0
node writeFileSync in os.tmpdir()               -> write ok, rc=0
mkdir/touch in /tmp                             -> rc=0
node listen 127.0.0.1                            -> listen EPERM, rc=1
```

The relative `mkdtemp` attempt resolves its prefix under the worktree, so its refusal is the same
worktree write boundary, not an independent refusal of `mkdtemp`. Both `$TMPDIR` (via
`os.tmpdir()`) and `/tmp` remained writable. The `listen` refusal is a separate network
boundary and is not evidence about file writes.

The result is a statement about the participant's effective shell policy: its worktree is not
writable, while temporary directories are. The measurement does not identify which internal
sandbox root or per-turn policy produced that boundary.

## How participant edits reach the worktree

Participants did edit worktree files during the day, so the old claim that no participant can use
`apply_patch` is also too broad. The successful route is the file-change tool path, not a shell
write: the shell's ordinary worktree write is unavailable from the start, while the holder sees
file-change approvals. PB-191 records the crucial distinction: the current
`item/fileChange/requestApproval` generation carries no path and is denied; an older
`applyPatchApproval` generation carries `fileChanges` paths and remains the candidate route
for an in-root edit. The exact legacy live allow is still an open measurement, not a conclusion of
this card.

A shell approval can be allowed by the holder and still fail at the participant's filesystem
boundary. Escalating the shell command can bypass that local restriction for the current worker,
but escalation is an operational workaround, not evidence that the participant's declared
worktree is writable.

## Cost and boundary

A participant that cannot write cannot commit either: Git writes to the same worktree. Another
process may insert the missing text and commit on its behalf, but that is not a scalable participant
route. The mechanism currently has no measured relift or diagnostic that distinguishes this boundary
from an ordinary permission error before a whole card is lost.

The old hypothesis that the worktree narrows during a session is therefore not established. A
future measurement must identify the effective writable roots at lift and after a refused write,
then decide whether the mechanism detects and relifts the participant or refuses it loudly.

## Work to do

- Name the source of the participant's effective writable roots and distinguish it from the separate
  network restriction shown by `listen`.
- Give the participant a diagnostic that says the declared worktree is outside its writable roots,
  rather than only `operation not permitted`.
- Decide whether the mechanism relifts the participant when its worktree is unavailable or reports
  the refusal before the participant spends the card.
- Capture the legacy/current file-change approval methods separately; do not use this card to infer
  which Codex protocol generation produced a successful edit.

## Verification

- The measured inside probe above: worktree write check fails from the first minute, `$TMPDIR` and
  `/tmp` writes succeed, and `listen` is separately refused.
- The rejected mid-session narrative remains in the card as a false starting point with its source
  named.
- The unresolved writable-root cause and the legacy file-change approval route remain explicitly
  open; the card is not archived.
