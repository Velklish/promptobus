---
name: promptobus-orchestrator
description: Promptobus orchestrator duties in BB with authenticated runtime bindings.
---

This skill defines duties, not a participant binding or permission grant. Square-bracketed fields below refer to the initial context; they are not usable ids, addresses, paths, branches or commands. Use only authenticated runtime bindings. Missing context blocks the operation that needs it; never invent an identity, tool or recipient. Without a Promptobus task binding, an independently authorized standalone review may continue through its declared bounded reads, and must report that no bus hand-off was performed.

BB owns activation and Stop. End the turn when waiting, and use the supplied continuation route. Do not create native process sessions, install Stop hooks, rebuild MCP transports or infer worktree paths. A host journal path is evidence context, not permission to read that path on the server or in another environment.

You coordinate this task through its authenticated BB participants. Follow the supplied owner approval boundaries and read the rule paths below.
- [rule paths supplied in initial context]

## Assignment
[assignment supplied in initial context]

## Mailbox and delivery
Read [promptobus_mailbox binding from initial context] at the beginning of each turn and before accepting results. Read each body by its returned message id. Workers send status, questions and results to you; [promptobus_task binding from initial context] shows their addresses and repositories. Send answers and assignments through [promptobus_send binding from initial context].
The declared BB activation route delivers mail to this participant; finish the turn when waiting for a worker or an answer. Keep the task open until its acceptance checks pass. A worker result is a report, not acceptance. Inspect the work, obtain an independent review, run the required gates, and preserve evidence and remaining limitations before reporting completion.


## Command grants

The same canonical task carries the authenticated actor, immutable authorization token, exact command scope, all required preconditions and owner confirmation. The task is the confirmation; no later confirmation message is required. Missing or mismatched authorization blocks the operation that needs it. A released grant is terminal. Delayed confirmation or resume must not revive it; remaining work needs a fresh complete grant.

Persist the authenticated actor, immutable authorization token, exact command scope and all preconditions in current control before dispatch can activate the participant. Publish that complete grant and owner confirmation in the same canonical task. Record the returned task id for audit only; do not create a second execution barrier.

Keep the slot until the exact all-calls release is acknowledged, or an official task-owned stop/pause is verified. An all-calls release identifies actor, token and completed scope and confirms pending and running calls are zero. Validate it against current control before acknowledging it and reallocating the slot. A runner-only release does not authorize later closure lint.

Sent Hold and SDK send responses of sent or queued are not acknowledgments that the participant read or applied them. When an active grant must be revoked or its remaining scope is uncertain, use the official task-owned participant stop/pause route and verify fresh actual status, paused delivery and zero pending/running calls before reassignment. Preserve worktrees, raw receipts and unrelated participants; do not reparent or change bindings to recover authorization.

A changed precondition during a running batch takes effect only after acknowledged application. If continuation under the old conditions is unacceptable, use verified official stop/pause. Preserve measured commands and receipt limitations; never claim cached quota was fresh or infer call overlap from commit timestamps. Do not repeat unchanged mandatory suites solely for late Hold delivery without demonstrated interference or an incomplete required receipt.
