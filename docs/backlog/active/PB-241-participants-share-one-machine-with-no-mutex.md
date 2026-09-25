# PB-241 · Participants of one task share a machine and the bus offers them no mutex

- **Scope:** [01-overview](../../reference/01-overview.md)
- **Created:** 2026-09-22
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 70
- **Taken:** 2026-09-25

## Context

The bus lifts several participants of one task at once, each in its own
worktree. Their trees are isolated; the machine is not. Anything they measure
— a performance gate, a wall-clock assertion, a suite with a timeout — is
measured on a box that the other participants are loading at the same time.

On 2026-09-21, three workers of one task ran their gates simultaneously and the
one-minute load average reached 63 on an 8-core machine. Every number produced
in that window was worthless, and the reds it produced cost several review
rounds to explain.

The run worked around it with a hand-rolled convention: an orchestrator-issued
queue plus `mkdir /tmp/da-perf.lock` as a mutex, with a load threshold before
entry. It held, and its weaknesses are the ones an empty directory has:

- it carries neither pid nor timestamp, so a waiter cannot tell "someone is
  measuring" from "someone was killed and left the directory behind" — during
  the run one holder was killed and the directory stayed;
- it is invisible to the bus, so `status` shows participants as busy without
  showing that two of them are blocked on each other;
- every participant has to be told about it in prose, and one of them entered
  the window without it early in the run precisely because the prose had not
  reached it yet.

## Work to do

- **The owner's decision, 2026-09-25:** the bus owns it. A machine-wide lease with a holder and a timestamp, kept by the bus; `status` names who holds the machine and since when; a lease whose holder is gone is released by liveness, not by waiting forever; participants learn about the lease from the preamble the bus gives them, not from prose in their brief. The convention-only route is not taken.
- Decide whether the bus owns this. The participants are its own, it knows
  which of them are alive, and it already has a place to keep per-task state;
  a machine-wide lease with a holder and a timestamp is a small thing next to
  what the warden already does.
- If it does, make waiting observable: `status` should say who holds the
  machine and since when, so an orchestrator does not diagnose a queue by
  looking at a directory in `/tmp`.
- If it does not, say so in the orchestration skill and describe the
  convention there once, instead of leaving each run to invent it.

## Out of scope

- Deciding how many participants may run at once. That is the orchestrator's
  call and depends on the machine.

## Verification

- Two participants of one task, both asked to measure, do not measure at the
  same time, and neither of them was told about the mechanism by prose in its
  brief.
- A holder that dies does not block the others indefinitely.

## Re-triage, 2026-09-23

Checked on `39316bc2` from the repository root. **Cost `major`**: participants who measure at the same time produce worthless wall-clock numbers and reds that cost review rounds. Every run with more than one participant on one machine invents its own convention.

- The bus has no machine-wide lease. `grep -rn -i "lease\|mutex" lib src` finds only the protocol's fan-out lease (`src/v1/messages.ts`, "who is writing this fan-out") and the store's directory lock (`src/fs/lock.ts`); the MCP tools are `promptobus_send`, `promptobus_mailbox` and `promptobus_task` (`src/mcp/tools.ts`).
- No document describes a convention: `grep -rn -i "mutex" docs/reference docs/guides skills` finds none.
- A current instance, from outside the tree: the brief of this re-triage (2026-09-23) carries its own prose rule — one full `npm test` per machine, taken by asking the orchestrator for "the npm test slot" — because a neighbour's load turns this suite's e2e files red. That is the prose convention the card describes, still hand-delivered.
- Not tree-checkable: the load average of 63 on 2026-09-21 and the `/tmp` directory lock of that run.
- Neighbours: PB-228 (the same cause class, this repository's own suite) and PB-222 (its second work item, two approvers on one clone, is the same mutex question at clone scope).
