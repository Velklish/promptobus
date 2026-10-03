# PB-331 · A participant owns one mailbox, its addresses in tasks are aliases, and the role rules list and enforce whom it may write

- **Scope:** [04. Protocol § Addresses](../../reference/04-protocol.md#addresses)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major

## Context

A mailbox today is a pair of a task and an address: `<home>/tasks/<task>/inbox/<address>/`. A teamlead is one session with two addresses in two tasks, `teamlead:<slug>` in the root and `orchestrator` in its child task, and its Claude Code bus entry reads only the child one.

- PB-318 (0.24.0, [ADR-026](../../adr/adr-026-teamlead-one-mailbox.md)) added a forwarding rule for root mail.
- PB-318.1 measured that sibling mail still lands in the root slot that the teamlead cannot read.

Every further relation between tasks would need a forwarding rule of its own. The address model is the cause.

Sessions are not stable either. On 2026-10-03 in run bs020 both teamleads died at the Claude plan limit and were lifted again, and `worker:adr` was lifted again on the same address and stayed deaf for its piece (PB-324).

Owner decisions on 2026-10-04:

1. A participant has one persistent mailbox. Its addresses in tasks are aliases of that mailbox. Sibling mail gets no second forwarding rule: PB-318.1 is solved here.
2. The mailbox belongs to the participant, not to a harness session. A session lifted again for the same participant gets the same mailbox, with its unread mail and its notification channel.
3. Whom a participant may write is derived from the role rules (`routingPolicy`, `lib/store.js:311`) and the run's membership. The participant gets this list at lift and from `promptobus_task`. The rule is enforced: a send to an address outside the list fails, whatever the agent does.
4. A participant mailbox lives as long as the journal of the participant's last task. The retention that removes task journals removes it with that journal; it gets no cleanup command of its own.

## Work to do

- Design first, owner's approval before code: an ADR that replaces ADR-026's forwarding. It covers:
  - the store layout;
  - the migration of unread mail in existing tasks;
  - the journal and the digest across tasks;
  - warden knocks per mailbox;
  - what a relift inherits.
- One mailbox per participant, with task addresses as aliases; root mail and sibling mail both reach it with their sender kept.
- The contact list from the role rules, in the lift prompt and in `promptobus_task`.
- Enforcement in the send door for every role pair, with a test per pair.
- Migration of unread mail that earlier versions left in per-task slots.
- Retention: the participant mailbox leaves with the journal of its last task.

## Out of scope

- Changing which roles may write to which: the rules stay as they are.

## Verification

- A sibling teamlead's message is read and marked in the receiving teamlead's session, and no unread count remains in either task.
- A participant lifted again after its session died reads the mail sent before the relift and is woken by the next one.
- A send to an address outside the sender's contact list fails, in a test for every forbidden role pair.
- PB-318's root-mail tests pass unchanged or are replaced by equivalent tests named in the ADR.
