# PB-407 · Root done refuses forever after the orchestrator claimed a closed Codex teamlead's child task

- **Order:** 340
- **Scope:** [03. CLI § Spawn](../../reference/03-cli.md#spawn)
- **Created:** 2026-10-29
- **Dependencies:** none
- **Cost:** major. The root task cannot be closed and its merged worktrees cannot be swept by `done`; nothing is lost, and the participants are already stopped.

## Context

A consumer run on 2026-10-28 lifted two Codex teamleads from one Claude root orchestrator with `spawn --teamlead`. Each teamlead ran its child task to the end, but its own `done` did not complete, so the root orchestrator stopped the teamlead from the root (`promptobus stop teamlead:<slug> --task <root>`), took the child's mailbox with `promptobus_mailbox {claim: true}` and ran `done` on the child. Both child tasks are `done`. Both root teamlead records carry a `nativeStop` proof with an `alias` naming the root and `teamlead:<slug>`.

On 2026-10-29, with every participant stopped, `promptobus done --task <root>` exited 1 with `✖ participant orchestrator: native work is active or unresolved; confirm Stop before done or recovery`.

The refusal comes from `linkedTeamlead` (`lib/native-lifecycle.js:48-58`), which `requireNativeTerminal` calls for a teamlead whose stop proof is an alias:

```52:57:lib/native-lifecycle.js
  if (parent.parent !== undefined || child.parent !== parent.id || leads.length !== 1
    || !native(lead) || lead.mode !== 'managed' || !native(owner) || owner.mode !== 'attached'
    || child.owner !== owner.id || owner.metadata.owner !== record.threadId
    || record.address !== ORCHESTRATOR || record.task !== child.id
    || [lead, owner].some(p => p.sessionRef !== record.ref || p.metadata.sessionId !== record.threadId
      || (p.metadata.nativeLaunchId && p.metadata.nativeLaunchId !== record.launchId))) refuse(record.address);
```

In both child tasks the `orchestrator` participant is still `harness: codex`, `mode: attached`, with `metadata.sessionId` equal to the teamlead's thread id, but `metadata.owner` is the claiming Claude session's id, not that thread id. The stop proof's `threadId` is the Codex thread. So `owner.metadata.owner !== record.threadId` holds and the root's `done` refuses for each teamlead. The refusal names `orchestrator`, the child's address, not the teamlead, so it reads as if the root's own orchestrator were the problem.

The reference describes `claim` on a child as making the root slot the root record's own again (03-cli § Spawn). It does not say that the claim also makes the root unclosable.

## Work to do

- Decide what proves a teamlead terminal once its child task was claimed and closed by someone else: the closed child plus the teamlead's own stop receipt, or a claim that records the previous owner so the link check can still match.
- Make the root's `done` accept a teamlead whose child is `done` and whose stop proof matches, whichever owner the child's `orchestrator` holds after a claim, without accepting a live or unproven native session.
- Name the teamlead and the child task in the refusal when the link check fails.
- Document the claim-then-close path in 03-cli § Spawn and the orchestrate skill.

## Out of scope

- Changing how `claim` binds a live mailbox.
- The reasons the teamleads' own `done` did not complete.

## Verification

- Fails on current code: a root with one Codex teamlead whose child task was claimed by another session and closed, with the teamlead stopped and its alias stop proof written; the root's `done` refuses with `participant orchestrator: native work is active or unresolved`.
- After the fix the same fixture closes, and a fixture whose teamlead session is still alive or has no stop proof still refuses, naming the teamlead.
