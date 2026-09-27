# ADR-019: Session identity is a driver member, the address is per task, and a positive binding is the barrier

**Status:** Accepted
**Date:** 2026-09-12
**Deciders:** the repository owner, standing mandate of 2026-09-12 to close the forks in an ADR, and the planning dialogue of 2026-09-26 that made a per-task address unavoidable. The positive binding was accepted when the registered send command landed.

## Context

The harness-neutral core used to read one harness's variable directly:

```js
sessionIdentity = env.CLAUDE_CODE_SESSION_ID?.trim() || null
```

Measured 2026-09-12 on live participants, that reader returned a wrong id on the command path — a Codex participant's environment carried `CLAUDE_CODE_SESSION_ID` from the parent, because the Codex session-environment drop list dropped only `CODEX_HOME` — and nothing at all on the MCP path. codex-cli 0.146.0 hands an MCP server child eleven variables (`HOME LOGNAME PATH PWD SHELL SHLVL TERM TMPDIR USER _ __CF_USER_TEXT_ENCODING`) and not one harness session variable. Measured free, with `thread/start` into a synthetic `CODEX_HOME` whose only MCP server dumps its environment.

All three harnesses do name themselves, each in its own variable: `CLAUDE_CODE_SESSION_ID`, `CURSOR_CONVERSATION_ID` (measured in cursor-agent 2026.09.10 — the shell tool sets it and deliberately keeps it out of persisted environment snapshots), `CODEX_THREAD_ID`.

The bus address had the opposite defect. It came from the `env` block of the MCP config that started the process and nothing moved it afterwards, while `declaredTask` is read separately and every bus tool takes a `task` argument. A session could not be the orchestrator of a second task. A teamlead is one session that is `orchestrator` of its own task and `teamlead:<slug>` of its parent ([ADR-021](adr-021-task-tree-and-governance-routes.md)). Without a per-task address there is no teamlead.

The first `promptobus send` was withdrawn before release, on 2026-09-12, after four review rounds of one class — the command granting more rights than it promised:

1. a silent fallback to the orchestrator address;
2. a declared `PROMPTOBUS_ROLE` taken on trust;
3. the same fallback on a task with no owner;
4. an ownership check that was negative: `foreignSessionOf` in `src/protocol.ts` answers `null` for a matching session and for a record bound to no session alike, so "this process is that participant" could only be answered negatively.

The direct worker–approver route is fail-closed on the same fact. An integration stand that injected `CLAUDE_CODE_SESSION_ID` into a Codex-shaped child passed while every real Codex direct send would have hit "calling harness supplied no session identity".

## Decision

**Command-path identity.** `DriverOptions.identityVar` is the variable a harness uses to name its own session, or `null` when it has none. It sits beside `knockChannel` and `envDrop`. The member answers for one path — a command the session runs — and does not answer for an MCP server child.

`resolveSessionIdentity` returns the id when exactly one declared variable is set; `null` with a reason when none is; and `null` with a reason naming both claimants and their variables when two are. Picking one would repeat the leaked-ancestor defect. The refusal is warned once per process. An environment that names no harness is a legal state and is not warned about.

The resolver is injected into the core, not imported by it. `lib/drivers.js` binds it with `bindSessionIdentity` at import. `lib/cli.js` binds it explicitly as well, because its command modules are imported dynamically and not all of them load the registry. Unbound, the core answers `null` and says once that no registry is bound. It never falls back to reading a variable itself.

The core does not import `lib/drivers.js`. That import loads when `store.js` is the entry module and dies when a driver module is — `ReferenceError: Cannot access 'CLAUDE' before initialization` at `lib/drivers.js`, taking the adapter and Cursor driver suites down before their first check. Every driver imports `store.js`, so the back edge is unavoidable. Moving `sessionIdentity()` out of `store.js` remains a possible later shape; the binding above is that behaviour with the fallback removed.

**MCP-child identity.** `DriverOptions.mcpIdentity` is `{ recordVar: string, idField: string } | null`, beside `identityVar` but answering a different path. Codex declares `PROMPTOBUS_CODEX_SESSION` / `threadId`; Cursor declares `PROMPTOBUS_CURSOR_SESSION` / `chatId`; Claude declares `null` because its current MCP path uses the ordinary harness identity. A per-driver function was rejected: the security-critical binding check would be copied, and a driver could return an id without proving the same task or address. Injecting the raw harness id was rejected because Codex's id is not known when the MCP config is written. Weakening the direct-route gate was rejected because an unproven process would borrow a registered address.

The registry considers the record proof only when the environment supplies no command-path identity candidate. A record proves its pointer when its `home` and the MCP process's declared home resolve through the same physical-path normalizer, and its `task` and `address` match exactly. Its harness id may still be null. Path normalization applies only to `home`. Missing, unreadable or differently bound records produce no identity. Two valid record proofs are contested and refused, the same rule as two environment claimants.

The lift writes that exact pointer as the participant's `sessionRecord` before launch, and keeps it when the harness id is added to `sessionId`. `holdsSession` accepts either the validated pointer or the existing id binding. Claude Code instead receives a chosen UUID through `--session-id`, written on its participant record before launch. A record with none of these bindings still cannot send.

While the driver record's id does not match the participant's id binding, the MCP resolver presents the pointer. Once they match, it presents the id, so a session holding another task's record by that id keeps its per-task route. The participant accepts both during the transition. The MCP connection resolves its stable coordinates at handshake, then refreshes identity for every `tools/call`. Task selection remains per call; the proof is bound to the MCP process's declared task.

**Per-task address.** A session's address is a property of the pair (session, task). One session may hold one address per task. The bus rule that participants correspond only through the orchestrator is unchanged; it is a rule about a pair of addresses.

**The barrier.** A positive binding: every lift and every owner claim records the session on the participant, and a sender is the participant of the named task whose recorded session matches the caller's identity from the driver resolver or the record pointer. An unbound record can be read and cannot send. `promptobus send` is registered only on that barrier. `holdsSession` answers yes only when the calling session is the one on the record — the task's recorded owner for `orchestrator`, the `sessionId` a lift wrote (or its short `session` by prefix) for any other address. `foreignSessionOf` keeps its `null` for an unbound record; that answer stays right for reading and no longer reaches a send. `senderFor` resolves the sender in the task a call names, for the CLI and the MCP tool alike. Each of the four withdrawn-command findings is refused by a check of its own: nothing falls back to `orchestrator`, a declared `PROMPTOBUS_ROLE` is a hint that must agree with the record of its declared task and a disagreement names both, a task with no recorded owner has no provable orchestrator, and a record bound to no session is never sent as. A message does not register its sender. The address a session holds comes from a lift or an owner claim and from nothing else.

There is no `--from`. A sender that can be chosen is a sender that can be borrowed. Any process that reads the journal can name any address in it.

The positive session binding now gates the registered `promptobus send` command. A sender must prove the address it holds in the named task; an unbound participant record grants no send right. See [Send](../reference/03-cli.md#send).

## Consequences

- `status` can show an owner, and `claim` can refuse a foreign session, for a session of any declared harness, on the path where the harness names itself. A leaked ancestor identity produces a named refusal. A process that reaches the store without loading the driver registry gets `null` and one warning. A fourth harness declares one field and needs no change in the core.
- Real-shape Codex and Cursor MCP children can use direct worker–approver traffic when their session holds the registered address, including through the pointer before a harness id appears. Cursor's generated bus MCP entry carries its session-record pointer explicitly. Canonical and symlink spellings of one existing home prove the same binding. A future harness must declare both identity paths independently.
- A teamlead, a peer and the person's `user` address are expressible. [ADR-021](adr-021-task-tree-and-governance-routes.md) and [ADR-022](adr-022-user-addressee-and-orchestrator-debt.md) rest on this.
- A participant whose harness gives its MCP child no identity cannot send. The session-record pointer used by Cursor and Codex MCP children lets the normal lift prove its binding before a harness id appears.
- The first implementation of `promptobus send` was withdrawn because a negative ownership check could not prove an unbound record. The barrier that closed that attempt is this positive session binding, and the command is registered only on it.
