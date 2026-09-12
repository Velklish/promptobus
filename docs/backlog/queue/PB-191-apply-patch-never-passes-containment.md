# PB-191 · `apply_patch` never passes the measured Codex participant boundary

- **Order:** 70
- **Scope:** `lib/codex-session.js` (`pathsOfApproval`, the `MUTATION_APPROVALS` branch at :874-884), [03-cli](../../reference/03-cli.md) § The Codex holder, [guides/hooks-and-trust](../../guides/hooks-and-trust.md)
- **Created:** 2026-09-12, orchestrator's measurement during the 0912c backlog run
- **Dependencies:** none

## Scope of the title

The title is bounded to the measured participant boundary, not every Codex release or every historical
approval schema. Two independent Codex participants, both running codex-cli 0.146.0, produced no
successful `apply_patch` call: the current pathless file-change request was refused for one, and the
other participant's wrapper returned `patch rejected by user` without applying a file. Successful
worktree edits used the separate escalated command route. That route distinction is the reason the
title does not generalize beyond the two participants and this binary version.

The containment check is right and stays. A mutation whose bounds cannot be established is a
mutation the holder must not approve. The holder's first branch is:

    const raws = pathsOfApproval(params);
    if (!raws.length) {
      const why = method === 'item/fileChange/requestApproval'
        ? 'item/fileChange/requestApproval carries no path to contain'
        : 'action target is unreadable';
      return { allow: false, why };
    }

## Live measurement

Two independent Codex participants were measured on 2026-09-12 with codex-cli 0.146.0:

    participant A, current file-change request:
    2026-09-12T16:14:27.787Z approval deny item/fileChange/requestApproval
      item/fileChange/requestApproval carries no path to contain
    2026-09-12T16:14:27.788253Z codex_core::tools::router
      error=patch rejected by user
      harness result: Script error: patch rejected by user
      no file applied

    participant B, apply_patch wrapper:
      Script error: patch rejected by user
      no file applied

No person rejected either edit. Participant A reached the holder's current
`item/fileChange/requestApproval` method, which carries no path, and the holder refused before
the patch could change the tree. Participant B independently received the same outcome at the
harness boundary. Within this two-participant measurement, `apply_patch` never passed.

The same two participant measurements separated the successful route from the refused one:
ordinary shell worktree checks were refused, while worktree edits passed through
`exec_command` with `sandbox_permissions=require_escalated` and an explicit justification. The
holder journal names that route as allowed `item/commandExecution/requestApproval`; an independent
generated `git apply` through that route exited 0. This is a measured route for these participants,
not proof that an un-escalated shell can write.

`applyPatchApproval` is the older schema shape: its `fileChanges` map supplies path keys that
`pathsOfApproval` can inspect. Neither live participant measurement received that method, so
whether a current binary emits it and whether an in-root request is accepted remains open. The
measured title therefore covers the current participant boundary and observed `apply_patch` calls,
not an unseen legacy route.

## What is established and what is not

- Two independent codex-cli 0.146.0 participants had no successful `apply_patch` call; one was
  refused by the holder's pathless current method and one was rejected by the wrapper without a
  file being applied.
- The current `item/fileChange/requestApproval` request without a path is refused fail-closed with
  a reason that names the method and missing containment input.
- Ordinary, un-escalated shell writes did not pass the participant worktree boundary in either
  measurement. `item/commandExecution/requestApproval` is a separate route; its allow does not
  override an OS-level worktree refusal.
- Worktree edits did pass through explicitly escalated `exec_command`, including an independent
  generated `git apply` with exit 0. This is the passing route measured here, not a universal
  participant guarantee.
- The holder's containment logic and `pathsOfApproval` stay unchanged.
- The legacy `applyPatchApproval` path and the exact condition under which a live participant
  reaches it are not established by this turn.
- The router text `patch rejected by user` is misleading: it hides a holder denial and falsely
  suggests a human decision.

## The participant-facing gap

The refusal text that reaches a participant names neither the method nor the missing path. A
participant therefore cannot distinguish a fail-closed file-change request from a human refusal.
The measured fallback is not an ordinary shell command: that route was refused in both participants.
The only successful worktree route observed here required explicit command escalation. Guidance that
omits that boundary closes the route that actually worked.

## The boundary is the worktree itself, not the write method — measured 2026-09-12

A participant of run 0912c took four plain-shell writes, no escalation, in its own worktree, and a
fifth and sixth outside it. The orchestrator asked for them to test whether the refusal depends on
depth — the repository root against a subdirectory. It does not.

```
printf 'x\n' >> AGENTS.md        → 1   operation not permitted   (root)
printf 'x\n' >> docs/README.md   → 1   operation not permitted   (subdirectory)
touch ./probe-root-check.tmp      → 1   operation not permitted   (root)
touch docs/probe-sub-check.tmp    → 1   operation not permitted   (subdirectory)

mkdir -p /tmp/pb-orch-probe       → 0   created, then removed
mkdir -p "$PWD/.probe-here"       → 1   operation not permitted

git checkout -- AGENTS.md docs/README.md
                                  → 128 EPERM creating .git/worktrees/…/index.lock
```

**The participant's plain shell cannot write anywhere inside its own worktree, and can write to
`/tmp`.** Depth makes no difference; the boundary is the worktree. Even `git checkout` fails, because
git needs its own lock file inside `.git`.

This inverts the picture the card carried until now. The card's remedy — "write through shell" — was
inferred from participants that did write successfully, and the natural reading was that the plain
route works and `apply_patch` alone is blocked. The measurement says the plain route does **not**
work at all here: every successful edit in this run went through the escalated route, and the
escalation is what made it look like shell worked.

**Two things follow, and neither is guesswork.**

1. **The remedy in this card is wrong as written.** Telling a participant to "write through shell"
   describes a route its plain shell does not have. What it actually needs is the escalated route,
   by name, with the note that ordinary writes will be refused with `operation not permitted` and
   that the refusal is not about the file.
2. **`/tmp` is writable while the worktree is not**, which is the opposite of what the recorded
   sandbox mode `workspace-write` suggests by its name. Either the mode is not what the name says, or
   the participant is not running under the mode the session record claims. Both are checkable, and
   neither has been checked.

**Still not established.** Whether this was true from the first minute of the session or changed
partway — the same participant committed repeatedly earlier in the run, and whether those commits
went through escalation was not recorded at the time. The next measurement worth taking is the
cheapest one: the same four commands at the start of a participant's life, before any work.

## Work to do

- Capture a live holder request using the legacy `applyPatchApproval` shape and an in-root
  `fileChanges` path, then record whether containment allows it. Do not infer that result from the
  current `item/fileChange/requestApproval` refusal.
- Decide whether the holder should derive a path for the current method or keep failing closed with a refusal that names the method and missing path.
- Document a participant fallback only after its shell boundary is known; if shell is refused, the
  participant needs a loud route to escalation or a relift rather than an instruction that simply
  fails.
- Measure the other mutation approval methods before claiming that only file-change requests are
  pathless.

## Out of scope

- Weakening the containment check or `pathsOfApproval`.
- The participant worktree sandbox boundary itself; PB-194 records that measurement.
- Hook firing for a Codex participant; PB-185 is a separate gate.
