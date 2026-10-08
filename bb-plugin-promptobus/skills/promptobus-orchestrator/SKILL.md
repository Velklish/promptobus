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
