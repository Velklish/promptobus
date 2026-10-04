# ADR-028: A participant owns one mailbox: each of its task addresses is an address alias of it, and the role rules list and enforce whom it may write

**Status:** Accepted
**Date:** 2026-10-04
**Deciders:** the owner, by four decisions of 2026-10-04: a participant has one persistent mailbox, its addresses in tasks are address aliases of it, and sibling mail gets no forwarding rule of its own; the mailbox belongs to the participant, not to a harness session; whom a participant may write comes from the role rules and the run's membership, is given to it, and is enforced; the mailbox lives as long as the journal of the participant's last task and has no cleanup command of its own. On the same day the owner chose 5B, 7B and 8A below and approved the design.

## Context

**A mailbox is a task and an address.** Unread mail for an address is the directory `tasks/<task>/inbox/<participant id>/` (`inboxDir`, `src/v1/layout.ts:85`), and a read renames each reference into `history/<participant id>/` of the same task (`readInbox`, `src/v1/messages.ts:300`). The warden of that task counts it (`supervisorRound`, `src/supervisor.ts:445`) and knocks the contact point in that task's `wake/<address>.json` (`wakeFile`, `src/sidecar.ts:37`). A participant with an address in two tasks therefore has two mailboxes, two contact points and two wardens.

**The teamlead is that participant.** It is one session with `teamlead:<slug>` in the root task and `orchestrator` in its child task ([ADR-021](adr-021-task-tree-and-governance-routes.md)), and its Claude Code bus entry reads only the child's `orchestrator` mailbox. [ADR-026](adr-026-teamlead-one-mailbox.md) closed the root half of the gap with forwarding. A root send to `teamlead:<slug>` is written into the child as `root:<root slug> → orchestrator` (`lib/store.js:1578-1580`, `deliverDown` at `:1623`). A read of the child mailbox first re-delivers root mail an earlier release left at the root (`drainRootSlot`, `lib/store.js:1631`, called at `:1695`). A child send to `root:<root slug>` is written into the root as the teamlead (`lib/store.js:1581-1591`). Sibling mail was left out. A stand on the release that shipped that decision recorded the cost (reported with the finding, not run again here): `promptobus send teamlead:a --task <root> --type question` from the `teamlead:b` session exited 0; the `teamlead:a` session's `promptobus_mailbox {}` answered `empty` for its child task and `promptobus_mailbox {task: <root>}` answered `FOREIGN MAILBOX`; `countInbox(<root>, teamlead:a)` was still 1 after both reads. Each further relation between tasks would need a forwarding rule of its own.

**A participant lifted again on its address stays deaf.** Two observations stand behind this, with different code paths.

*A worker or a reviewer.* On a consumer's run of 2026-10-03, a worker lifted again into its worktree after its session died received mail only through the Stop guard at its turn end, which for a worker is the end of its piece. The orchestrator of this repository's run of 2026-10-04 reported the same for a worker and a reviewer lifted again; that report is not measured here. Code reading, a hypothesis rather than a measured trace, gives four steps:

1. A Claude Code lift binds the record before launch to a UUID it chose (`prelaunchBinding`, `lib/driver-claude.js:574`; `bindBeforeLaunch`, `lib/liftoff.js:8`, called at `:36`). Claude Code 2.1.284 printed `warning: --bg manages the session id; ignoring --session-id` on every lift of the 2026-10-04 run (recorded with a finding of that run, not run again here), so the session runs under another id until the post-launch persist writes the id `claude agents --json` names (`lib/liftoff.js:70`).
2. The session's bus entry hands its contact point over at the MCP handshake (`join`, `src/mcp/server.ts:285`). `registerWake` refuses while the record names another session (`lib/driver-claude.js:471`).
3. `join` marks the task entered when ownership allows a handover, not when the handover was written. For every address but `orchestrator`, `ownership` answers `other-address` (`lib/store.js:982-984`), so `mayRegister` is true and the task joins `joined` (`src/mcp/server.ts:294-296`) although `registerWake` returned `null`. That connection never hands over again, and the next attempt is the Stop guard's at turn end (`lib/guard.js:511`).
4. Until then `wake/<address>.json` names the dead session. The warden reads it as a point held by a foreign session (`wakeTakenBy`, `src/supervisor.ts:174`) and falls back to self-wake without a knock (`src/supervisor.ts:608`). Past the 30-second spawn grace, `status` says the channel "returns to it on its next turn end" (`lib/driver-claude.js:349`).

*A teamlead.* After both teamleads of the 2026-10-03 run were lifted again, `status` named both channels deaf until each new session's first turn end. Step 3 does not hold for a teamlead. Its bus entry is on its child's `orchestrator`, where `ownership` answers `foreign` until the lift's rebind names the new session (`lib/store.js:982-992`), so `mayRegister` is false, the task is not added to `joined` (`src/mcp/server.ts:294-296`), and `join` runs again on the next tool call (`:286`). A relifted teamlead therefore hands over its child point at its first bus call after the rebind. What nothing in the current code writes or rewrites for a Claude Code teamlead is the point of its root record, `wake/teamlead-<slug>.json` in the root: the guard's sweep `handOverContactPoints` covers only tasks whose `orchestrator` record the session owns (`lib/warden.js:161-172`), and the teamlead's bus entry never joins the root as `teamlead:<slug>`. A point found there names an earlier session, and the root warden reads that record's channel as taken by it. Code reading does not tell which of the two lines `status` printed on that run.

**Whom a participant may write is enforced and never told.** The routing policy (`routingPolicy`, `lib/store.js:311`) runs inside the engine before the first side effect of a send and refuses with `policy-denied` (`src/v1/engine.ts:205-213`). Every package door that writes a message reaches it through `sendMessage` (`lib/store.js:1532`): `send` and `ask` (`lib/send.js`), `promptobus_send` and the reporter's ask (`lib/server.js`), and the assignment `review` sends on a re-review (`lib/review.js:812`). No participant is given the list the policy implies, so it learns a refusal by hitting it. `test/governance-routes.test.mjs` covers a sample of pairs in six tests, not every pair.

## Options

**Decision 1: what the participant mailbox is on disk.**
- 1A. The slots that exist today, read as one. A participant's mailbox is the slots of all its addresses: one read takes all of them, one count sums them, one warden knocks for them. Nothing moves.
- 1B. One new directory per participant, `mailboxes/<key>/`, with each inbox reference hard-linked into it from the task the message was sent in. Every participant's mail moves, so every reader of an earlier release goes deaf during an upgrade. The engine's fan-out and recovery learn a second location. A reference outlives a child journal pruned before its root, while the child's attachments leave with that journal.
- 1C. Per-task mailboxes with a forwarding rule per relation. Excluded by the owner.

**Decision 2: what identifies a participant.**
- 2A. Its session. Excluded by the owner: a relift or a `claim` changes the session, and the mailbox must survive both.
- 2B. An id minted at the first lift and stored in every record of the participant. Records an earlier release wrote, and lift paths that rebuild a record, do not carry it; a missing field would split one mailbox into two without a word.
- 2C. The record its lift bound, its primary address, with its other addresses derived from the task links the journal already holds.

**Decision 3: the teamlead's primary address.**
- 3A. The child task's `orchestrator`: the address of its bus entry, its session binding, its contact point and the warden that knocks it today.
- 3B. The root's `teamlead:<slug>`. It would move the contact point and the knocking warden of every running teamlead, and a child warden of an earlier release would keep knocking the old place.

**Decision 4: where root mail to a teamlead lands.**
- 4A. In the root slot of the address it was sent to, `teamlead-<slug>`, where sibling mail lands.
- 4B. In the child, as ADR-026 delivered it. One address would then deliver by sender: root mail into the child, sibling mail into the root.

**Decision 5: how a relift moves the contact point.**
- 5A. The lift drops the dead session's point, and the bus entry repeats a handover the binding refused until the post-launch persist binds the record, for at most 63 seconds. Rejected by the owner: the handshake handover still fails first, and the channel waits on the persist.
- 5B. The lift drops the dead session's point and gives the new session a pointer to a session record it wrote. At the handshake the session proves the pointer, binds its own harness id and hands its point over at once. The pointer as a proof is the shape Codex and Cursor already use ([ADR-019](adr-019-session-address-per-task-lands.md)); the write that binds the session's own id into the participant record at the handshake is new, and no driver does it today. Chosen by the owner.
- 5C. The first handover after a lift wins, whatever session makes it. Rejected: any session in the workspace could take the address in that window.

**Decision 6: how the contact list is enforced.**
- 6A. The list is the routing policy enumerated over the participant's tasks. The engine enforces the policy as it does now, and the send door's refusals carry the list.
- 6B. A stored list checked beside the policy. Two rules for one question drift, and the one that drifted would decide without a word.

**Decision 7: mixed releases during an upgrade.**
- 7A. Root mail to a teamlead whose child `orchestrator` record an earlier release wrote keeps that release's delivery into the child. Rejected by the owner: a transitional delivery path, and a release to remove it, for a window a relift closes.
- 7B. No transitional delivery. Chosen by the owner.

**Decision 8: how long a teamlead's two slots live.**
- 8A. Each slot with its own journal: the child slot leaves with the child journal, the root slot with the root journal. Chosen by the owner.
- 8B. Child journals stay until their root is pruned, so the whole mailbox leaves at once. It changes the retention of every child task.

## Decision

1A, 2C, 3A, 4A, 5B, 6A, 7B and 8A, approved by the owner on 2026-10-04.

### Store layout and the key

**A participant mailbox is the set of mailbox slots of its addresses.** A slot is the pair the store has today: `tasks/<task>/inbox/<participant id>/` and its `history/` twin. No directory is added and no reference moves. One read of the mailbox reads every slot, oldest message first across slots, and moves each reference into the history of its own slot. One count sums the slots, and one warden knocks for the sum.

**The key is the participant's primary address: the task and address its lift bound.** For a teamlead that is the child task's `orchestrator`, the record `spawn --teamlead` binds and its bus entry names in `PROMPTOBUS_TASK` and `PROMPTOBUS_ROLE`. For a root orchestrator it is its root task's `orchestrator`, and for every other participant its one address. A lift on the same address keeps the key. A worker, reviewer or approver is lifted again in the same task under the same address; a teamlead relift refuses without its child task (`lib/spawn.js:699`); a `claim` changes the owner, not the address.

**Address aliases are derived from links the journal already holds, and hold only while one session holds both records.** The root's `teamlead:<slug>` record names its child in `metadata.childTask`, and the child names its root in `parent`; both are written under the task locks by every release that has the task tree. A root `teamlead:<slug>` record is an address alias with a slot, of the participant whose primary address is its child's `orchestrator`, while three things hold: its `childTask` names a child, that child's `parent` names the root, and the root record's `sessionId` and the child `orchestrator`'s owner name one session. That last condition is the proof every write route of the pair already asks (`rootTeamlead`, `lib/store.js:239-251`). When the two records name different sessions, as after a `claim` on the child, the root record is a participant of its own: one address, one slot, read by the session that holds that record and under the same gates as today. The claimant's mailbox does not include it, so the claimant never takes mail addressed to the teamlead it replaced. A teamlead relift refuses such a pair without a pending rebind (`lib/spawn.js:705-708`); the address alias holds again once both records name one session.

Two governance addresses keep no slot, as now. `root:<root slug>` in a child and `peer:<slug>` in a root are addresses of another task's orchestrator, and a send to either is written into that orchestrator's own task (`lib/store.js:1565-1577`, `:1581-1591`), so mail to them reaches the one mailbox already. `user` and `reporter` stay one address per task: no record links a person's `user` in two tasks, and `ask` names the task.

`mailboxOf(home, task, address)` in `lib/store.js` answers `{ primary, slots }` by these rules, and every reader below asks it.

### Unread mail an earlier release left

**Nothing moves: every place a package door of an earlier release left unread mail for a participant is one of its slots.** By route of the routing table:

- Mail to a child's `orchestrator`, from its workers and, under ADR-026, root mail written as `root:<root slug>`, is in the teamlead's primary slot.
- Root mail from before ADR-026, root mail to a teamlead whose child was closed, and every sibling message are in the root slot `teamlead-<slug>`, the teamlead's address alias slot.
- A `root:<root slug>` or `peer:<slug>` slot holds nothing: `sendMessage` writes a send to either into the other task before the engine sees it (`lib/store.js:1565-1577`, `:1581-1591`), and `test/teamlead-root-mail.test.mjs` asserts the zero for `root:<root slug>`. A reference a caller of the bare engine API wrote there is read by nobody, now as before.
- Every other route lands in the one slot of a participant with one address.

The drain goes. `drainRootSlot` and its call in `readInbox` are removed, and with them the re-delivery under new ids. A message an earlier release left at the root slot is read in place, under its own id, with its attachment in the root's files.

### The journal, the mailbox reads, status and digest

**The journal does not change.** A message stays canonical in the task it was sent in, between the addresses as named there, and its record carries that task. No message is written down into a child task any more: the downward branch of `sendMessage` (`lib/store.js:1578-1580`) and `deliverDown` (`:1623`) are removed. Peer delivery between roots and the `root:<root slug>` route keep writing into the destination task with `originTask`, as now.

**`promptobus_mailbox` returns the caller's participant mailbox.** The tool resolves the caller's address by the record the session provably holds in the task the call names (`mailboxAddress`, `lib/store.js`), with the `holdsSession` proof `senderFor` uses for a sender. Where the call names no session, or the session holds no record there, it falls back to the declared role, as now. The `orchestrator` owner gate, the foreign copy and `claim` keep their meaning for the slots of the participant they judge: a call that resolves to an address alias is gated at its primary address, because it reads the primary's slot too, so a session that does not own the child's `orchestrator` gets a copy of both slots and marks neither, and `claim` names the child task whose `orchestrator` mailbox a claim takes. A `claim` on a teamlead's child moves the child slot to the claimant and ends the address alias, so the root slot stays with the root record, and the claimant's call naming the root task gets the root orchestrator's foreign copy, as today. A teamlead's call that names its child task returns its root slot too, and the same call naming the root task returns the same mailbox rather than `FOREIGN MAILBOX`. The header of a message from a task other than the call's names that task beside the sender address as recorded there: `### status from teamlead:group-two · task <root id> · <time>`. A body asked by id is looked up in the history of every slot.

**`promptobus_task`, the unread tail of a `send` reply and the Stop guard count the participant mailbox.** `status` prints the sum on the line of the primary address, and on an address alias line `address alias of orchestrator of task <child id> · unread <N> here, counted there`. After a read, no unread remains in either task.

**`digest` pairs by participant.** A question from one participant is closed by a newer answer from the other, address aliases resolved, in any journal of the tree. Under 4A both directions between a root orchestrator and a teamlead are written in the root, so a new pair is found in one journal; the two-journal pairing of `treeAnswered` (`lib/digest.js:57-70`) stays for journals an earlier release wrote. `history` stays a view of one journal.

### Warden knocks

**One participant, one contact point, one knocking warden.** The contact point lives at the primary address, `wake/<primary address>.json` in the primary task. A handover through any address alias writes there: `registerWake` checks the binding of the record the handover names, then resolves the address alias and writes at the primary. That order is the safe one: the alias record is bound to the teamlead's session, while the gate passes any session on `orchestrator` (`foreignSession` answers `null` for that address, whose own gate is `ownership`). Wardens stay one per task. The warden of the primary task counts every slot of the participant, watches the address alias slot directories beside its own, keeps `health` under the primary address and knocks once, with one coalescing window across the slots. A warden skips an address alias record: it does not knock it, does not escalate it to `SILENT`, and does not count it toward its own exit check. A root `teamlead:<slug>` record that is not an address alias, because its pair names two sessions, is knocked by the root warden as any participant of its own. When the primary task is closed nobody knocks the participant, because a teamlead whose child is done has finished; `status` still names unread mail at an address alias slot in an active root.

### What a relift inherits

**Unread mail: the slots belong to the address, not to the session.** A relift on the same address reads the same slots.

**The notification channel: the lift drops the dead session's point. A participant bound before launch then binds itself at its handshake through a pointer; a teamlead hands over at its first bus call after the rebind.**

*Dropping the old point.* In the step that binds the new session, under the task lock, the lift removes `wake/<primary address>.json` when the session it names is not the one being bound, and with it any point at an address alias, such as `wake/teamlead-<slug>.json` in the root. That step is `bindBeforeLaunch` (`lib/liftoff.js:8`) for a participant bound before launch, and the rebind a teamlead relift applies (`recoverTeamleadRebind`, `lib/spawn.js:600`) for a teamlead. The warden then reads no contact point instead of a point held by a foreign session, and `status` does not call a freshly lifted channel deaf.

*The session record and its pointer.* Every Claude Code lift that binds its record before launch, the worker, reviewer, approver and reporter lifts through `bindBeforeLaunch`, writes a session record beside the participant's MCP config, in the same step and with the same mode `0600`: `workers/<file stem>.session.json` of the participant's task. It names `home`, `task` and `address` and carries `sessionId: null`. A relift writes it afresh, so a previous session's binding never survives into the next lift. The lift adds the record's path to its prelaunch binding as `metadata.sessionRecord` (`lib/driver-claude.js:574`), beside the chosen UUID, and puts the same path into the bus entry of the MCP config as `PROMPTOBUS_CLAUDE_SESSION`. Only a session started with that config carries it. It sits in the task's `workers/` rather than a harness state home because Claude Code's driver has none, and it leaves with the participant's other lift files at `sweep` and `done`.

*The handshake binds, once.* At `join`, before the binding gate, the Claude Code driver reads the pointer from its environment. It accepts it only when all of these hold: the session record proves the same physical home and the exact task and address, as `mcpIdentityCandidates` proves a Codex or Cursor record (`lib/drivers.js:128-152`); the participant record's `metadata.sessionRecord` names the same path; and the session record's `sessionId` is `null` or equals the session's own `CLAUDE_CODE_SESSION_ID`. Then, under the task lock, it writes that id into the session record and into the participant record's `metadata.sessionId`, replacing the chosen UUID. The binding gate runs after it unchanged (`foreignSessionOf`, `holdsSession`), and the participant record now names the session, so the handover is written at the handshake. The first proven handshake binds and nothing rebinds after it. A later handshake that presents the pointer with another id is refused by the same gate, and the refusal is kept in the session record as `refused`, with the id and the time, so `status` prints it on the participant's line instead of the bus binding it to another session in silence. The post-launch persist keeps a handshake binding and writes nothing over it. It checks that binding only against the id the harness itself names, `sessionIdFull(seen)` (`lib/liftoff.js:133`), and never against `full`, which falls back to the chosen UUID when the harness names none (`lib/liftoff.js:68`). When the harness names an id and it disagrees with the binding, the lift fails with both ids named and the route to stop it and lift it again. When the harness names none, the handshake binding stands and this check refuses nothing; a lift bound to no session at all is still refused on the existing unbound path (`lib/liftoff.js:80-87`).

*The assumption it rests on.* The rule assumes two things nobody has measured. First, Claude Code starts the bus MCP server at session start, before the first turn, so the participant's own handshake is the first to present the pointer. Second, a subagent of the participant either uses the participant's MCP connection or, if it starts an MCP child of its own from the same config, carries the participant's `CLAUDE_CODE_SESSION_ID`. If the second is false, the subagent's handshake is refused and shown in `status`, and the participant keeps its binding. If the first is false and a subagent proves the pointer first, the persist's check fails the lift rather than leaving the participant bound to the subagent, on a build whose `claude agents --json` names the session's id; on a build that names none, nothing catches that order. Phase 2 measures both on a live Claude Code session before the code is written.

*A teamlead gets no pointer.* Its ownership of the child `orchestrator` moves with the rebind the lift applies after launch, and its handshake cannot hand over before that: `ownership` answers `foreign` and `joinBus` writes only behind `mayRegister` (`lib/server.js:63-70`). Its relift needs two things, and both are above. The lift drops the dead session's child point and the stale root point. The root record keeps no channel of its own, because it is an address alias of the child `orchestrator`, and its mail is knocked through the primary point. The teamlead's first bus call after the rebind, which `join` repeats until the session is the owner, hands over that one point, and mail that landed before it is knocked at the handover. A teamlead whose only bus calls come before the rebind lands hands over at its turn end, as now; how often that happens is not measured.

This also settles a lift that records the `--session-id` value `claude --bg` ignores: the record names the real id from the session's first handshake, and the persist only confirms it.

**The stand that holds it.** The stub harness gets an opt-in mode in which `--bg` ignores `--session-id` and prints the warning 2.1.284 prints; `test/harness.mjs:413` takes the flag today. On it: lift a Claude Code worker, whose handshake hands over socket S1; kill the session; lift it again on the same address with the same spawn, its handshake running before the persist; send it a message before its first turn ends; drive warden rounds. The stand asserts that a knock reaches S2, that the participant record's `sessionId` is the stub session's own id and not the chosen UUID, that `wake/worker-<slug>.json` names that session, that the dead session's point was gone before the handshake, and that `status` prints no deaf channel. Beside it, refusal cases: a pointer naming another task or address, a pointer the participant record does not name, and a later handshake with another id after the bind, which is refused and printed by `status`. A second stub mode, whose `claude agents --json` record carries no session id, asserts that the participant is bound to the session's own id from its handshake and that the lift succeeds. A teamlead relift on the same stub asserts that the lift removes the child point and the root `wake/teamlead-<slug>.json`, that the root warden neither knocks nor flags the root record, and that the teamlead's first bus call after the rebind writes the primary point, which the child warden knocks for root and sibling mail. On the current code the worker gets no knock before its turn end: the handshake is refused, it is not repeated, and the old point reads as taken.

### The contact list and its enforcement

**The list is the routing policy enumerated.** `contactsOf(home, participant)` walks every task the participant has an address in, every other record of that task and every message type. It keeps each recipient address for which `routingPolicy` allows at least one type, with those types and the task to name. Two addresses of one participant, such as the root orchestrator's `orchestrator` in the root and `root:<root slug>` in the child, form one entry. The rules do not change, and the direct worker and approver pair keeps its session proof at send time (`requireDirectSender`, `lib/store.js:1503`).

**The list is given twice.** The lift prompt of a worker, reviewer, approver, teamlead and reporter carries it in a section `Whom you may write`, computed at lift, with a line saying that membership grows during the run. `promptobus_task` prints the current list on a `you may write:` line.

**Enforcement stays in the engine, before the first side effect of a send, behind every door.** Every package path that writes a message reaches the engine's `send` or `sendSync`, and both ask the policy first. The send door adds the list to the two refusals it gives a participant, `policy-denied` and `task <id> has no participant`, so a refusal says where the message may go: `<reason> · you may write: orchestrator (all seven types) in task <id>; approver:<slug> (all seven types) in task <id>`. A process with write access to the store directory can still place a file there; the bus is not a sandbox, and that boundary does not move.

**Every role pair is tested.** The test carries a table written from the routing table of [04-protocol § Addresses](../reference/04-protocol.md#addresses), not computed from the policy. It gives the allowed types for every sender and recipient role of the registry: `orchestrator` of a root and of a child as two senders, `teamlead`, `root`, `peer`, `reporter`, `user`, and one step of each kind. Each pair is a test of its own. An allowed type is delivered, and a refused type is refused with the policy's reason and the sender's list. One more test holds `contactsOf` equal to the allowed cells, so the list and the enforcement cannot drift. The direct pair of a declared owner and the `writes-main-tree` step is pinned as the code has it, within one task and without matching slugs (`acceptanceRoute`, `lib/store.js:1489-1495`).

### Retention

**The participant mailbox has no directory of its own, so it leaves with its slots, each slot with its own journal.** The retention that removes a closed task's journal 14 days after its close removes the slots, histories and `wake/` files in it. A teamlead's child slot leaves with the child journal. Its root slot, and the root's record of it, leave with the root journal, the last of its tasks to close: a root does not close while a child is active. No reference crosses a journal, so pruning a child leaves nothing behind in the root. Nothing new is cleaned and no command is added.

### Sibling mail

**Sibling mail needs no rule of its own.** `teamlead:a → teamlead:b` keeps landing in the root slot `teamlead-b`. While `b`'s pair names one session, that slot is an address alias slot of the participant whose primary address is the `orchestrator` of `b`'s child task, so that participant's read takes the message and marks it read in the root, and the child's warden knocks for it. The route's own conditions, four types and both records bound to their child owners (`rootTeamlead`, `lib/store.js:239-251`), do not change.

### Compatibility

**Writers of an earlier release land in slots that are part of the mailbox.** Root mail they write into the child is in the primary slot, sibling mail is in the address alias slot, and the `root:<root slug>` route is unchanged, so nothing they write is lost.

**A teamlead lifted by an earlier release misses root mail after a mid-run upgrade and must be lifted again.** Its bus entry reads only its child slot, and root mail now lands in the root slot. No transitional delivery keeps it whole. A relift gives it a current bus entry, which reads both slots, including the root mail that landed before the relift. Sibling mail stays out of reach of such a session, as it is today.

**A child claimed by another session ends the address alias** (§ Store layout and the key). Until both records name one session again, root and sibling mail to `teamlead:<slug>` stays in the root slot under that record's own gates and is not shown to the claimant.

**A warden of an earlier release counts only the slot of its own task.** A child warden started before the upgrade does not knock for mail in the address alias slot. The Stop guard of a current session counts that mail and returns the turn, and the next warden of the task counts it. A root warden of an earlier release still knocks a `wake/teamlead-<slug>.json` that a Codex teamlead's root entry wrote, so such a teamlead may be knocked twice until that warden exits.

**A Claude Code session lifted by an earlier release carries no pointer.** Its handshake meets the gate as today, and its contact point arrives at its Stop guard as today.

**`status` and `digest` of an earlier release read per task, as before.** The Codex teamlead keeps its root bus entry for sends as `teamlead:<slug>`. Its mailbox call through either entry returns the same participant mailbox, and both entries hand over to the one point at the primary address.

**Tests of the teamlead root-mail route** in `test/teamlead-root-mail.test.mjs`, by name:

| Test | Fate |
|---|---|
| a root send to teamlead:\<slug\> lands in the child orchestrator mailbox, not in the root | replaced by: a root send to teamlead:\<slug\> lands in the root slot and counts once in the teamlead's mailbox |
| the warden knocks the teamlead once for it, on the child task only | stays unchanged |
| the teamlead reads it with its own mailbox tool and that read marks it read in both tasks | stays unchanged |
| mail already read draws no knock, past the re-knock threshold too | stays unchanged |
| a second message draws exactly one more knock | stays unchanged |
| sibling traffic between teamleads stays in the root task | stays unchanged, joined by: sibling mail is read and marked by the receiving teamlead's mailbox, and no unread remains in either task |
| the message keeps its origin: root:\<root slug\> in the child, originTask the root | replaced by: root mail keeps its sender, the root task's `orchestrator`, named with its task in the teamlead's mailbox header |
| a reply to root:\<slug\> reaches the root orchestrator as teamlead:\<slug\>; the named-task route still works | stays unchanged |
| root:\<slug\> talks only to the orchestrator of a child task | stays unchanged |
| mail left at the root slot by an earlier version moves into the child on the teamlead's read; sibling mail stays | replaced by: mail an earlier version left at the root slot is read in place with sibling mail, keeps its id, and is marked read in the root |
| a root-slot message that cannot move stays unread there, and the read still succeeds | removed with the drain: nothing moves |
| a root-slot message whose attachment record is gone stays there rather than moving without its file | removed with the drain: nothing moves, so nothing moves without its file |
| a drain that fails outside one message still returns the child mailbox, and the next read retries it | replaced by: a read that fails on the address alias slot still returns the primary slot, names the failure, and the next read takes the address alias slot |
| the digest pairs a question and its answer across the root and the child | stays unchanged |
| root and task views name where the teamlead's mail lands | replaced by: status and task show the teamlead's address alias line and count its mail at the primary address |
| a send to root:\<slug\> is refused while the root record and the child owner name different sessions | stays unchanged |
| mail to the teamlead of a closed child stays in the root task | stays unchanged |

A new test holds the claimed child: after a `claim` on the child, sibling mail to `teamlead:<slug>` stays unread in the root slot and is not in the claimant's mailbox. The check `docs: a teamlead reads root mail in its child task, and the drain is documented` in `test/documentation-contract.test.mjs` is replaced by a check of the new teamlead paragraph of 04-protocol § Addresses and of this record's decision line.

## Consequences

- ADR-026 is rewritten in the pass that lands this decision, as principle 2 of `docs/README.md` asks. Its decisions on where root mail lands and on the drain are removed. What still governs stays under its number: the `root:<root slug>` record, its address shape and the 0.22.0 measurement behind it, and the child's route to the root. Its row in `docs/README.md` changes with it.
- The reference changes with the code: 04-protocol § Addresses (the teamlead paragraph and the delivery column of the teamlead rows, while the types stay; the direct owner and `writes-main-tree` pair is described as the code has it, within one task), 03-cli § Spawn (the drain and the Claude Code session record), § Status, done, sweep (the session record leaves with the mcp-config), § Digest and § Guard and warden, 01-overview § join, 02-host § Session identity (the Claude Code pointer beside the Codex and Cursor ones), 05-drivers (the Codex teamlead at the install root), the orchestrate skill's teamlead section, the glossary and the CHANGELOG.
- Every reader of unread mail asks `mailboxOf`. A reader that counts or reads one slot by address reads part of a participant's mail; the tests above hold the guard, the warden, `status`, `promptobus_task` and `promptobus_mailbox` to the participant count.
- A new relation between tasks adds an address alias rule to `mailboxOf` rather than a forwarding rule.
- The warden of a primary task watches directories of another task.
- A Claude Code participant bound before launch gains a session-record pointer, so all three drivers prove an MCP child the same way. The write that binds the session's own id at the handshake is new: no driver binds a participant record from its handshake today, and the post-launch persist becomes the check of that binding rather than its source.
