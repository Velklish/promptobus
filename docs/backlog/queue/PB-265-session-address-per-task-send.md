# PB-265 · A session holds one address per task, and promptobus send ships on a positive proof

- **Order:** 20
- **Scope:** [04-protocol § Addresses](../../reference/04-protocol.md#addresses), [03-cli](../../reference/03-cli.md), `src/protocol.ts`, `lib/store.js`, `lib/send.js`, `lib/cli.js`, `src/mcp/`
- **Created:** 2026-09-26
- **Dependencies:** none for Claude Code; PB-178.1 for a Cursor or Codex participant, whose MCP child carries no harness identity
- **Cost:** major

## Context

A session's bus address comes from the `env` block of its MCP record: `participantMcp` in `lib/spawn.js` writes `PROMPTOBUS_ROLE`, `PROMPTOBUS_TASK` and `PROMPTOBUS_HOME`, and `lib/store.js` reads the role from it. The task argument of every bus tool moves the task and never the sender, so a session that opened a task of its own writes to that task's participants as the address of its birth and is refused: `workers and workers do not write to each other` (`lib/store.js`, `routingPolicy`).

[ADR-011](../../adr/adr-011-a-session-address-is-per-task.md) decided that an address is a property of the pair (session, task). Its first implementation, `promptobus send`, was withdrawn before release after four review rounds found four majors of one class — the command granted more than it promised — and the fourth named what stopped it: `foreignSessionOf` in `src/protocol.ts` answers `null` both for a matching session and for a record with neither `session` nor `sessionId`, so a declared role for an unbound participant passed. The code, its 21 checks (`grep -c "check(" test/send.test.mjs`) and the withdrawn argv shape stay on `main`; `lib/cli.js` does not register the command and `test/send.test.mjs` pins the unbound-address hole as known.

The owner decided on 2026-09-26 that a child orchestrator — a teamlead — is one session holding two addresses: `orchestrator` in its own task and `teamlead:<slug>` in the parent task (PB-267, PB-269). That is exactly the per-task address, and it cannot land on a fail-open ownership check. The card «A session cannot write to a participant of another task: its own address is nailed by its MCP config, and there is no `send` command» ([PB-179](../../archive/LOG.md#pb-179)) is merged here: its measurement of 2026-09-12 and its re-triage of 2026-09-23 are the evidence above.

## Work to do

- Every lift, and the owner claim of a task, writes a positive binding of the participant record to the session — `metadata.session` and `metadata.sessionId` where the harness exposes them, the session-record pointer of [ADR-014](../../adr/adr-014-mcp-session-proof.md) where it does not. A record without any binding is legal to read and illegal to send as.
- The sender of a bus call is resolved per task: among the participants of the named task, the one whose recorded session matches the caller's identity from the driver resolver of [ADR-010](../../adr/adr-010-session-identity-is-a-driver-member.md). `PROMPTOBUS_ROLE` becomes a declared hint that must agree with that record; a disagreement is refused naming both.
- The four findings of the withdrawn round are each closed by a check: no fallback to `orchestrator`, no declared role taken on trust, no send on a task with no owner, no send from an unbound record.
- `promptobus send <to> --type <t> --task <id> [--body | --file]` is registered in the dispatcher, `help` and [03-cli § Send](../../reference/03-cli.md); the MCP tools use the same resolution.
- [ADR-011](../../adr/adr-011-a-session-address-is-per-task.md) gets an amendment section naming the barrier that landed; ADR-019 records the decision.

## Out of scope

- Which pairs of addresses may correspond — the routing table is PB-270; this card changes who the sender is, not who may receive.
- Lifting a teamlead (PB-269) and the parent link (PB-267).
- Identity of a Cursor or Codex MCP child (PB-178.1): until it lands, `send` from such a participant refuses with the identity reason rather than guessing.

## Verification

- A session that is `orchestrator` of task B and `teamlead:x` of task A sends `status` in both, and each stored message carries the right sender for its task.
- The known-hole check in `test/send.test.mjs` flips: an unbound `worker:one` cannot be written as by a session that exports `PROMPTOBUS_ROLE=worker:one`; the refusal names the missing binding.
- `node bin/promptobus.js help` lists `send`; `promptobus send` to a task with no recorded owner is refused.
- The 21 existing checks of `test/send.test.mjs` pass against the registered command without rewriting their argv.
