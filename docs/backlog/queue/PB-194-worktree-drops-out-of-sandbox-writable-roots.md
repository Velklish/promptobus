# PB-194 · A participant's worktree write boundary is measured at one instant; Git metadata is separate

- **Order:** 10
- **Scope:** [drivers](../../reference/05-drivers.md), the Codex participant sandbox boundary
- **Created:** 2026-09-12
- **Dependencies:** PB-191 for the file-change approval method

## Context

The earlier claim said that a participant lost write access to its own worktree in the middle of a
session. That is not established. It came from a participant report and an MTIME difference, not
from a probe run inside that participant at the time of refusal.

A fresh participant measured later gives a narrower result: its shell cannot write its worktree
from the first minute. That measurement does not describe the first participant's earlier state,
and it does not prove or disprove a transition in that session.

For the participant tied to the earlier mid-session report, the session started at 09:15, an active turn ran at 15:59, and the probe was taken at 16:11. No writable-root probe was taken at either the session start or the active turn, so the inside measurement supports only the state at the probe instant.

## Measurement from inside a fresh participant

Measured on codex-cli 0.146.0, from a freshly lifted participant, at
2026-09-12T16:11:43Z:

    test -w .                                      -> rc=1
    node mkdtemp with a relative prefix             -> EPERM: operation not permitted
    node mkdtemp in os.tmpdir()                     -> /var/folders/.../T/pb-probe-3F4sOn, rc=0
    node writeFileSync in os.tmpdir()               -> write ok, rc=0
    mkdir/touch in /tmp                             -> rc=0
    node listen 127.0.0.1                            -> listen EPERM, rc=1

The relative mkdtemp attempt resolves its prefix under the worktree, so its refusal is the same
worktree write boundary, not an independent refusal of mkdtemp. Both $TMPDIR (via
os.tmpdir()) and /tmp remained writable. The listen refusal is a separate network
boundary and is not evidence about file writes.

A second participant was later observed with the same shell state, while files in its worktree
had been modified minutes earlier. That observation identifies neither the author of those
writes nor whether the participant changed from writable to non-writable. The transition
question remains open.

## What successful edits establish

This worker did successfully edit and commit worktree files during the same run, using the
exec_command route with an explicit sandbox escalation. No successful apply_patch call was
captured: the measured current file-change call was denied as pathless. The holder journal
records allowed item/commandExecution/requestApproval events for shell commands.

This proves that the escalated command route can write for this worker. It does not prove that an
ordinary participant shell can write, that the legacy applyPatchApproval route is accepted, or
that every participant has the same effective roots.

## File-change approval remains separate

One apply_patch call from inside a participant received a holder refusal for
item/fileChange/requestApproval because it carried no path. The older
applyPatchApproval shape carries fileChanges paths, but no live allow of that method was
captured. PB-191 records the method distinction without declaring either route the general
successful path.

## Cost and boundary

A participant that cannot write cannot commit either: Git writes to the same worktree. Another
process or an escalated command may insert and commit text on its behalf, but that is an
operational workaround, not a measured participant route. The Git metadata probe is the narrow
exception measured in this run: an empty commit succeeded, then reset returned HEAD to 9e29fb2 with
a clean status. The worktree's Git indirection therefore remained writable even while ordinary
file creation was refused.

The old hypothesis that the worktree narrows during a session is therefore not confirmed or
refuted. A future measurement must inspect the effective writable roots at lift and after a
refused write, then decide whether the mechanism detects and relifts the participant or refuses
it loudly.

## Work to do

- Measure the same participant at lift and after a refused write; attribute any intervening file
  change before claiming a transition.
- Name the source of the participant's effective writable roots and distinguish it from the
  separate network restriction shown by listen.
- Give the participant a diagnostic that says the declared worktree is outside its writable
  roots, rather than only operation not permitted.
- Capture the current and legacy file-change approval methods separately, including the route used
  by a successful edit.

## Verification

- The fresh-participant probe above: worktree writing fails from the first minute, $TMPDIR and
  /tmp writes succeed, and listen is separately refused.
- A later participant showed the same shell boundary after worktree mtimes had changed; the writer
  and any transition were not identified.
- This worker's successful changes used escalated exec_command, while the current
  item/fileChange/requestApproval call was refused; neither observation proves a general route.
- The Git metadata probe returned commit rc=0 and reset rc=0; status was empty and HEAD returned to
  9e29fb2. This proves metadata-write capability, not ordinary worktree-file capability.
- The rejected mid-session narrative remains in the card as a false starting point with its source
  named. The unresolved transition, writable-root cause and approval route remain open; the card
  is not archived.
