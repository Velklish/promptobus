# PB-240 · The approver role writes to the shared clone, which the harness forbids a background agent

- **Scope:** [05-drivers](../../reference/05-drivers.md)
- **Created:** 2026-09-22
- **Dependencies:** none

## Context

Both approvers of the run on 2026-09-21 reported the same obstacle, in their
own words and independently: the harness running a background agent refuses
file edits through its editing tools in the shared clone until the agent moves
into its own worktree.

For an approver that is a contradiction with the role, not an edge case. The
role is defined as the one that writes to the main tree — it merges, runs
`archive`, and fills `result.md` there — and moving into a worktree would mean
a second merge. Both sessions completed their work by writing through the
shell instead, and both said so before doing it rather than after.

The gate does not actually stop the role, it only chooses its tools: `archive`
is a `git mv` in the shared tree and passes, because it runs as a command. So
what is guarded is the choice of tool, not the tree.

**The lift puts the approver there on purpose**, which is what makes this a
contradiction rather than a misconfiguration. `lib/approver.js` seats the
session in the clone root and attaches the worker tree beside it:

<!-- quote:../../../lib/approver.js -->
      ? `Worker tree ${worktreeDir} (${branchNote}) is attached read-write via add-dir; your session cwd is the clone root ${cwd}.`
<!-- /quote -->

[PB-225.1](PB-225.1-approver-attachments-outside-the-contract.md) records the
same seating from the other side — an approver owns no worktree, so it falls
outside a contract that is keyed on worktree ownership.

Which layer imposes the edit rule was not traced. The lift writes a settings
file per participant (`lib/approver.js`, `participantSettingsPath`; the file is
removed by `done`), so it may come from there, from the harness's own defaults
for background sessions, or from both.

## Work to do

- Find where the rule comes from for a lifted session, and say it in
  [05-drivers](../../reference/05-drivers.md). Right now a participant
  discovers it by hitting it.
- Decide what the approver's environment should be. If the role legitimately
  writes to the shared clone, it should be lifted with permission to do so;
  if it should not, the recipe has to change and the role needs another way to
  fill `result.md`.
- Until either, say in the approver's own skill that its writes go through the
  shell, so a participant does not have to discover a workaround and then
  wonder whether using it is allowed.

## Out of scope

- The worktree rule for workers. There it is correct: a worker editing the
  shared clone is always a mistake.

## Verification

- A lifted approver either writes to the shared clone with its normal tools,
  or its instructions say plainly how it is meant to write and why.
