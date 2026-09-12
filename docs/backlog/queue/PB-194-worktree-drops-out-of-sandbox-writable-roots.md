# PB-194 · The participant shell worktree is closed; escalated exec_command is the measured write route

- **Order:** 10
- **Scope:** [drivers](../../reference/05-drivers.md), the Codex participant sandbox boundary
- **Created:** 2026-09-12
- **Dependencies:** PB-191 for the file-change approval method

## Context

The earlier claim said that a participant lost write access to its own worktree in the middle of a
session. That is not established. It came from a participant report and an MTIME difference, not
from a probe run inside that participant at the time of refusal.

The measured contract is different and narrower: for two independent participants on
codex-cli 0.146.0, the participant's ordinary shell worktree is closed at every measured attempt;
the ordinary Git metadata probe below also failed at the linked worktree's `index.lock`.
`$TMPDIR` and `/tmp` remain writable, and both worktree and metadata writes pass only through an
explicitly escalated command. This is a two-participant, one-binary measurement, not a claim about
every Codex version or every sandbox.

For the participant tied to the earlier mid-session report, the session started at 09:15, an active
turn ran at 15:59, and the probe was taken at 16:11. No writable-root probe was taken at either the
session start or the active turn, so the inside measurement supports only the state at the probe
instant. The old mid-session-drop story remains a rejected starting hypothesis, not an observed
transition.

## Direct shell and neighboring paths

The first participant's inside probe ran on codex-cli 0.146.0 at 2026-09-12T16:11:43Z:

    test -w .                                      -> rc=1
    node mkdtemp with a relative prefix             -> EPERM: operation not permitted
    node mkdtemp in os.tmpdir()                     -> /var/folders/.../T/pb-probe-3F4sOn, rc=0
    node writeFileSync in os.tmpdir()               -> write ok, rc=0
    mkdir/touch in /tmp                             -> rc=0
    node listen 127.0.0.1                            -> listen EPERM, rc=1

The relative mkdtemp attempt resolves its prefix under the worktree, so its refusal is the same
worktree write boundary, not an independent refusal of mkdtemp. Both `$TMPDIR` (via
`os.tmpdir()`) and `/tmp` remained writable. The listen refusal is a separate network
boundary and is not evidence about file writes.

The independent second participant showed the same direct-shell boundary: `test -w .` returned
rc=1, and an un-escalated `git apply` reported Operation not permitted while unlinking and
writing files. No direct-shell worktree write succeeded in either participant measurement. The
successful edits in both were made only through the escalated command route described below.

## Measured routes and Git metadata

The three relevant routes are method-specific:

- **Ordinary shell:** test -w . returned rc=1; an un-escalated git apply reported
  Operation not permitted while writing the worktree; and
  git commit --allow-empty -m "probe: git metadata write, ordinary shell" returned rc=128
  with Operation not permitted while creating the linked worktree's index.lock. No commit
  was created.
- **Escalated exec_command:** with sandbox_permissions=require_escalated and an explicit
  justification, an independent generated git apply returned rc=0, and the reversible
  empty-commit/reset probe returned rc=0 for both operations. This route wrote both worktree
  files and Git metadata for two independent participants.
- **apply_patch:** one holder refused item/fileChange/requestApproval because it carried no
  path, and the other wrapper returned patch rejected by user without applying a file. It did
  not pass in either participant. The older applyPatchApproval shape, whose fileChanges map
  has paths, was not captured live and remains open under PB-191.

The prior empty-commit/reset result was launched through the escalated route; it does not establish
an ordinary metadata exception. The ordinary probe above is the contrary measurement for this
participant.

## Cost of the wrong explanation

The participant report plus mtime difference made the old mid-session-drop story plausible, but neither
identified a transition nor the author of the changed files. The more expensive operational mistake
was treating one refused method as proof that no participant route could work. Guidance not to request
escalation closed the only route measured as successful for another participant; the orchestrator
then had to commit that participant's branch by hand and return the task to the queue. The contract
must name the method and escalation boundary instead of generalizing from one refusal.

## What remains open

- Whether the first participant was ever writable at lift or during its active turn, and whether any
  participant can transition from writable to closed.
- The source of the effective writable roots and a diagnostic that names the declared worktree as
  outside them.
- Whether the legacy `applyPatchApproval` shape is still emitted and accepted, and whether other
  binary versions share this boundary.
- Why the holder receives a pathless current file-change request; PB-191 records the method
  distinction without weakening containment.

## Work to do

- Measure the same participant at lift and after a refused write; attribute any intervening file
  change before claiming a transition.
- Name the source of the participant's effective writable roots and distinguish it from the
  separate network restriction shown by listen.
- Give the participant a diagnostic that says the declared worktree is outside its writable roots,
  rather than only operation not permitted.
- Capture the current and legacy file-change approval methods separately, including the route used
  by a successful edit.

## Verification

- Two independent codex-cli 0.146.0 participants: direct shell worktree probes were refused;
  `$TMPDIR` and `/tmp` writes succeeded, and the first participant's network listen was refused
  separately.
- The first participant's exact probe was taken at 2026-09-12T16:11:43Z; the earlier participant
  session had no root probes at 09:15 or 15:59, so no transition is claimed.
- The current `item/fileChange/requestApproval` route was refused without a path in one participant,
  and the other participant's `apply_patch` wrapper rejected with no file applied.
- Explicitly escalated `exec_command` worktree edits succeeded for both participants, including an
  independent generated `git apply` with exit 0.
- The ordinary git commit --allow-empty -m "probe: git metadata write, ordinary shell"
  returned rc=128 at index.lock and created no commit. The escalated generated git apply
  returned rc=0, and the prior escalated empty-commit/reset probe returned rc=0 for both
  operations before restoring HEAD to 9e29fb2.
- The rejected mid-session narrative remains as a false starting point with its source named. The
  transition, writable-root cause, legacy approval behavior and broader-version behavior remain open;
  the card is not archived.
