# ADR-017: The owner gate is a positive proof

**Status:** Accepted
**Date:** 2026-09-16
**Deciders:** the run's orchestrator, on the brief of [PB-223](../archive/PB-223-ownership-gate-fails-open/task.md), which asks for the decision about a task with no owner to be named rather than left silent. **Not reviewed by the owner**: the boundary the card sets is the fork; what is recorded here is which branch of it was taken.

## Context

`ownership` answered one question — is this mailbox closed for another session — and answered
`gated: false` whenever it had nothing to compare:

```
if (!owner || !session) return { gated: false, owner, session };
```

Its readers split into two groups that want opposite defaults. The advisory ones — the
foreign-mailbox heading, the unread tail, the `status` warning, the attach gates of `spawn`
and `review`, the guard's successor hint — ask "may I call this mailbox somebody else's",
and on an absence of evidence they must stay quiet. The destructive ones — `done`, `stop`,
`dismiss` — ask "may this call end somebody's run", and they read `!gated` as a yes.

That made `done` reachable from any shell that carries no harness identity variable, over
**any** task in the store, a live foreign one included: it closes the task, stops the
participants' sessions, removes their worktrees and deletes the branches it judged merged.
There is no privilege boundary here — whoever calls already has the store directory — but
the gate does not exist against an outsider. It exists against the neighbouring session on
the same machine, and that arrangement is the standard one: several sessions of one
workspace, each with its own task. Against it the gate did not work.

[ADR-016](adr-016-cleaning-up-after-one-accepted-piece-is-a-verb-of-its-own.md) met the same
gate from the other side and rejected reusing it for the piece sweep, recording its default
as a **considered** fail-open for `done`: "its subject is the owner's own run, and a run
nobody owns has nobody to protect". PB-223 reopens exactly that sentence: a run nobody owns
is not the case that hurt — a run somebody else owns, entered by a call that names nobody,
is.

## Options

**Decision 1 — what the gate answers.**

**1A — one field with the direction flipped.** Make `gated` mean "the right was not proven"
and let every reader take it. Rejected: the advisory readers would then print the
foreign-mailbox heading at a plain shell reading its own task, and the `spawn` attach gate
would refuse a legitimate CLI run into the single active task. One field cannot carry both
questions, and forcing it to would move the defect rather than remove it.

**1B — two fields, and they are not each other's negation.** `allowed` is the right, proven
positively; `gated` stays the narrower "proved foreign" and keeps its readers untouched.
`right` names which of the answers it is, so a refusal can say what was not proven.

**Decision 2 — a task that records no owner.**

The owner is written into the `orchestrator` participant record only when the environment
supplied identity at `createTask`, so a run opened from a shell that names no session has no
owner by construction. The card demands this be settled out loud: such a task belongs either
to everyone or to nobody.

**2A — it belongs to everyone.** Any call passes, identity or not. Rejected: this is today's
silent behaviour with a name attached, and it leaves the destructive verbs open to a call
that names nobody. The card's whole subject is that an absence must stop reading as a yes.

**2B — it belongs to nobody, and the named exception is a session that names itself.** Such a
task cannot be owned by anybody provably, so nothing more than "the caller named itself" is
available to ask — and that much is asked. Chosen.

**2C — it belongs to nobody, full stop.** Every call refused until the mailbox is claimed.
Rejected on a measurement rather than a preference: `claim` lives only in the MCP tool
`promptobus_mailbox {claim: true}` and there is no CLI verb for it, so an ownerless task
would have no route to a close at all from the side that created it, and its worktrees and
journals would stay for good.

**Decision 3 — the tasks opened before the owner existed.**

**3A — a migration that writes an owner into them.** Rejected: there is no true value to
write. Any id chosen would be an invention, and an invented owner is worse than none — it
would refuse the one session that might legitimately close the task.

**3B — the named exception of 2B covers them.** They have no owner by the same construction
as a fresh shell-opened task, and they need no separate rule. Chosen.

## Decision

**1B, 2B, 3B.** The owner gate of `done`, `stop` and `dismiss` grants the right by evidence
and refuses every absence of it, and the answer carries the reason by name.

- **`allowed` is granted only by a proof**: the call names a session, and that session is the
  recorded owner — or the task records no owner and the call still names itself.
- **`gated` is unchanged, byte for byte**, and so is every advisory reader's behaviour. The
  lines that take it keep their silence where nothing can be compared; `lib/store.js` reads
  `gated` itself and is the main file of the change, so the claim is about behaviour rather
  than about which files the diff names.
- **`right` is one of `owner`, `ownerless`, `no-identity`, `foreign`, `other-address`**, and
  the refusal head (`unprovenOwnerLine`) and its route (`ownerRoute`) are built from it. Every
  branch of the route must be walkable by the caller that gets it: the claim route goes to the
  owner whose daemon died; a task with no recorded owner has no owning session to be sent to,
  so its route is "any session that names itself"; and a call whose environment names two
  harnesses is repaired by removing a variable, so it is told that and carries the resolver's
  own reason in the head ([PB-218](../archive/PB-218-two-identity-vars-read-as-none/task.md)
  named those two states apart, and a gate that ignored the distinction would contradict it
  in the same pass).
- **An address other than `orchestrator` grants no right, and has no refusal text either.**
  This gate does not judge it, and a question that was not asked is not a yes. Its `owner` is
  `null` because nobody looked it up rather than because the task has none, so
  `unprovenOwnerLine` and `ownerRoute` throw on it instead of printing "records no mailbox
  owner" about a task that has one: an answer the gate never gave has nothing true to say.
- **The piece sweep keeps its own gate.** The directions now agree, but the sets of callers
  do not: `requireSweeper` admits the approver of this task on its own recorded session, and
  refuses an ownerless task unless an approver proves the session. ADR-016 stands; only its
  reason for the deviation changes.

## Consequences

**A shell with no harness identity can no longer run `done`, `stop` or `dismiss`.** This is
the cost, and it is named rather than discovered: a harness names its own session, so the
route is a session that does, and on an owned task whose daemon died —
`mailbox {claim: true}` from the successor. A pure shell that opened its own task keeps the
close, because that task has no owner and 2B lets a self-naming session through; a pure shell
that names no session at all does not, anywhere.

**The suite must name its caller.** Four files called these verbs from a stand with harness
identity stripped by hygiene and passed only because the gate failed open; each now installs
an identity, the way `promptobus-sweep.test.mjs` already did. A file that cannot name its
caller can only ever see the refusal, and that is a property of the gate, not of the suite.

**`Ownership` in `src/protocol.ts` gained two required fields**, so a second producer of that
type — `src/legacy-store.ts` — answers them too. Its `gated` is untouched: the legacy store is
a migration reader, and nothing there consults `allowed`.

**What is left open.** The gate still cannot tell two identity-less callers apart, because
nothing in the environment distinguishes them; it only stops treating that as permission.
And a task with no owner remains open to any self-naming session — the strongest statement
available about it until a CLI route to `claim` exists.
