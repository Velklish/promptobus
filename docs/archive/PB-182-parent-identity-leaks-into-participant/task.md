# PB-182 · The orchestrator's session identity leaks into a participant's environment, and `sessionIdentity()` there returns the parent

- **Order:** 7
- **Scope:** `lib/driver-codex.js` and `lib/driver-cursor.js` (`SESSION_ENV_DROP`), `lib/store.js`
  (`sessionIdentity`)
- **Created:** 2026-09-12
- **Dependencies:** `PB-178` (the member this makes unavoidable)

## Context

Measured 2026-09-12 on a live Codex participant. The command, run by the participant from its own
worktree:

```
node -e "const m=await import('./node_modules/promptobus/lib/store.js'); \
  console.log(JSON.stringify(m.sessionIdentity()))" --input-type=module
```

Output, in full: `"02e821c6-9438-4540-96ba-3e0bb879516b"`, exit 0. **That is the orchestrator's
id** — not `null`, and not the participant's own `CODEX_THREAD_ID=01a092d3-7f10-7b53-…`.

The cause is in the environment the participant inherits: `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` are all present in it. The Codex
driver's `SESSION_ENV_DROP` carries only `CODEX_HOME`; the Cursor driver drops
`PROMPTOBUS_CURSOR_SESSION`, `AGENT_CLI_SOCKET_PATH`, `AGENT_CLI_LOG_PATH` and
`CURSOR_AGENT_SOCKET`, and neither drops the parent harness's variables.

**What it costs.** `createTask({ owner: sessionIdentity() })`, `withTaskLock({ session })` and
`foreignSession` inside such a process operate on the parent's identifier. Nothing observable
breaks today — a participant does not open tasks and owns no mailbox — so this is quietly wrong
data rather than a visible failure, which is the harder kind to find later.

**The path matters and splits the picture.** The leak is on the **shell path**: the
participant's own session and the tools it runs. On the **MCP path** the environment is scrubbed
entirely — a child of a Codex participant's MCP server receives eleven variables (`HOME LOGNAME
PATH PWD SHELL SHLVL TERM TMPDIR USER _ __CF_USER_TEXT_ENCODING`) and no `CODEX_*` at all,
measured on a synthetic home with a server that dumps its own environment, without a model turn.
So `sessionIdentity()` returns the parent's id on one path and nothing on the other, and both
paths call it.

**Measured across all three drivers 2026-09-12, without a live harness and without a paid turn** —
`sessionEnv` is set on each driver's object and `lib/spawn.js` calls exactly that, so a synthetic
parent environment was enough. Three things the card did not say when it was filed:

1. **The Claude driver leaks as well.** Its `SESSION_ENV_DROP` is `['CLAUDE_PID','CLAUDE_EFFORT']`,
   and `sessionIdentity()` on its output returns the parent's id exactly as the other two do. This
   card named only Codex and Cursor.
2. **Claude → Claude is saved by the harness, not by the mechanism.** Measured from inside a live
   Claude participant: `CLAUDE_CODE_SESSION_ID` is its own and the socket path carries its own pid
   — the harness overwrites both for a session it starts. The same-harness case is therefore
   correct by luck, and nothing in this package makes it so.
3. **Every driver passes on every *other* harness's variables**, not only Claude's: Codex hands on
   `CURSOR_CONVERSATION_ID`, Cursor hands on `CODEX_HOME` and `CODEX_THREAD_ID`.

**The cost is larger than "quietly wrong data".** `CLAUDE_CODE_MESSAGING_SOCKET` and its `_TOKEN`
are the pair the mechanism knocks with: `registerWake` puts them into the contact point and the
warden uses them. A Codex or Cursor participant inherits the **orchestrator's** socket and token,
not its own. **Whether a harness would accept a knock from a foreign process holding that token is
not measured**, and nothing here is presented as an exploit — it is an isolation defect on one
machine under one user. But a participant should not be able to read its orchestrator's wake
credentials at all, and today it can.

**An ordering trap in the fix, which must not be levelled by accident.** Claude and Cursor delete
**after** merging `extra`; Codex deletes **before**. While `extraEnv()` is empty this is cosmetic.
With an extended list, a host setting any of those names would get a silent deletion under two
drivers and a retained value under the third. Codex's order is the correct one and belongs in the
other two in the same pass.

**All three harnesses do carry a native id** where the shell can see it:
`CLAUDE_CODE_SESSION_ID`, `CURSOR_CONVERSATION_ID`, `CODEX_THREAD_ID`. The drivers already put
the right one into the contact point. What is missing is the member `PB-178` is about.

## Work to do

- Drop the parent harness's identity and messaging variables in every driver's
  `SESSION_ENV_DROP`. A participant must not be able to read its parent's session at all — not
  only must the mechanism not use it.
- Decide what `sessionIdentity()` answers on the MCP path, where there is nothing to read. That
  is `PB-178`'s member; this card must not paper over it with a second environment read. After the
  drop it will honestly return `null` instead of a foreign id, and that is the correct interim
  state — a second environment read beside it would look like a fix and would not be one.
- Bring Codex's deletion order into the other two drivers.
- A check that fails when a parent variable survives into a participant's environment, for each
  driver that drops one.

## Out of scope

- The identity member itself — `PB-178`.
- Variables a participant legitimately needs (`PROMPTOBUS_HOME`, `PROMPTOBUS_ROLE`,
  `PROMPTOBUS_TASK`), which the mechanism sets deliberately.

## Not measured

- Whether the MCP path is clean for Cursor as it is for Codex. It needs a live `cursor-agent` to
  start its own MCP servers, and the Codex result does not carry over: the launch routes differ.

## Verification

- `sessionIdentity()` inside a participant never returns the orchestrator's id.
- The parent's messaging socket and token are absent from a participant's environment.
