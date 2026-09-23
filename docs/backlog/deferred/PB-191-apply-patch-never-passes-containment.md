# PB-191 · `apply_patch` never passes the measured Codex participant boundary

- **Scope:** `lib/codex-session.js` (`pathsOfApproval`, the `MUTATION_APPROVALS` branch at :720-729), [03-cli](../../reference/03-cli.md) § The Codex holder, [guides/hooks-and-trust](../../guides/hooks-and-trust.md)
- **Created:** 2026-09-12, orchestrator's measurement during the 0912c backlog run
- **Dependencies:** none
- **Cost:** major

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

## Deferred

- **Deferred:** 2026-09-16
- **Reason:** Owner decision of 2026-09-16: the Codex cluster (PB-196, PB-194, PB-191, PB-185, PB-214) is deferred as a whole. The current run lifts Claude Code participants only, and every card in the cluster needs live Codex turns on the binary that PB-196 would replace — a fix measured against the old boundary would be lost with the upgrade.
- **Return condition:** A dedicated Codex run opens and PB-196 has upgraded codex-cli in it; this card is then re-measured on the new binary before anything is changed.

## Re-triage, 2026-09-23

Checked on `39316bc2` from the repository root. **Cost `major`**: on the measured binary a Codex participant's `apply_patch` never lands. What the participant is told is "patch rejected by user", and the only measured write route is escalated `exec_command`.

- The branch moved and the code did not. `grep -n "MUTATION_APPROVALS.has\|carries no path to contain\|^function pathsOfApproval" lib/codex-session.js` → exit 0: `:517` is `pathsOfApproval`, `:720` is the branch, `:726` holds the reason text. The quoted block is `:723-729` today; `:874-884` was right at filing, and the Scope line now names the current lines. Nothing in the logic changed: `git log --oneline --since=2026-09-12T00:00:00 -S"carries no path to contain" -- lib/` → exit 0, empty.
- The legacy shape carries paths: `test/fixtures/codex-app-server/0.146.0/ApplyPatchApprovalParams.json` requires `callId`, `conversationId` and `fileChanges`.
- The participant gets no reason at all, which is stronger than the card's "names neither the method nor the missing path". The holder answers `{ decision: 'decline' }` (`lib/codex-session.js:403`, returned by `approvalReply` at `:1056`), and `why` goes only to the holder log and the warden log (`:1053-1054`).
- `workspace-write` is the recorded mode: `grep -n workspace-write lib/driver-codex.js` → exit 0, `:34`, `:362`.
- The documentation half is written already: `docs/reference/03-cli.md:1006-1023` records the pathless refusal, the router text and the escalated route. What stays open is the live captures and the holder decision.
- Not tree-checkable and left as the author's records: the holder journal lines and the plain-shell probes of 2026-09-12 on 0.146.0. Whether 0.156.1 still sends a pathless `item/fileChange/requestApproval` is unknown until PB-196 generates its schema.

**Merged from PB-214.** PB-214's third work item — 96 refusals `carries no path to contain` over one run of five Codex participants (2026-09-12 19:05 to 2026-09-13 08:30, the holder journal; no count command recorded) — is this card's subject: the same method and the same branch. For 0.146.0 the fixture answers its question "is the path in another field": `test/fixtures/codex-app-server/0.146.0/FileChangeRequestApprovalParams.json` has `grantRoot`, `itemId`, `reason`, `startedAtMs`, `threadId`, `turnId` and no target path. `grantRoot` asks to widen the root and is refused outright (`lib/codex-session.js:682`, `grantRoot escalation denied`).

**Return condition: not fired** — see the re-triage of PB-196.
