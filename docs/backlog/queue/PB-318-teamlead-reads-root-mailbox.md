# PB-318 · A teamlead cannot read its root-task mailbox through the bus tools

- **Order:** 57
- **Scope:** [03. CLI](../../reference/03-cli.md)
- **Created:** 2026-10-03
- **Dependencies:** none
- **Cost:** major

## Context

On 2026-10-03 a root orchestrator (a Claude Code session) lifted two Claude Code teamleads with `spawn --teamlead` at v0.22.0 and sent each a `status` addressed `teamlead:<slug>` in the root task. Both teamleads reported, independently and unverified by the orchestrator, that they could not read that mail with the bus tools:

- `promptobus_mailbox { task: <root> }` from the teamlead session answered `FOREIGN MAILBOX: the orchestrator address … bound to session <root owner>`: the tool reads the `orchestrator` address of the named task, and has no argument to name the caller's own address in it.
- Both read the messages as files under `.promptobus/tasks/<root>/inbox/teamlead-<slug>/`, so the mailbox still counts them unread; one teamlead expects the Stop guard to keep returning its turn on them.

Later the same day the cost became measurable. The teamlead's bus server runs with `PROMPTOBUS_ROLE=orchestrator` and `PROMPTOBUS_TASK=<child>` (`.promptobus/tasks/<root>/workers/teamlead-<slug>.mcp.json`). The tools therefore reach the child task's `orchestrator` address and never the root task's `teamlead:<slug>`.

Mail on that address is delivered, but nothing ever marks it read. By the evening the two root-task inboxes held 26 and 24 messages. After both teamleads were relifted, the warden knocked one of them seven times in 17 minutes with «has unread: 26». Every knock took a turn of a Claude session and spent the shared 5-hour window.

The workaround was by hand. The root orchestrator moved the files the teamlead had read from `inbox/teamlead-<slug>/` to `history/teamlead-<slug>/`, the same rename `readInbox` does. The teamlead's own Stop guard held its turn on such a reply until it did the same.

The [orchestrate skill](../../../skills/orchestrate/SKILL.md) describes upward `status` from a teamlead to the root, but not how the root's mail to the teamlead reaches it.

## Work to do

- Reproduce: lift a teamlead, send it a message from the root, call `promptobus_mailbox` from the teamlead session with and without `task: <root>`; record the replies.
- Give the teamlead a way to read and mark read its root-task address through the bus tools, or route root-to-teamlead mail into the child task's `orchestrator` mailbox; record the choice in the reference.
- Check what the Stop guard does with unread mail at the teamlead's root address.

## Out of scope

- Sibling teamlead traffic, which already works per the skill.

## Verification

- A message from the root to `teamlead:<slug>` is read through a bus tool in the teamlead session and is no longer counted unread.
- `npm test` and the repository gates exit 0.
