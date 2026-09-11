# PB-182 · The orchestrator's session identity leaks into a participant's environment, and `sessionIdentity()` there returns the parent

- **Order:** 9
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

**All three harnesses do carry a native id** where the shell can see it:
`CLAUDE_CODE_SESSION_ID`, `CURSOR_CONVERSATION_ID`, `CODEX_THREAD_ID`. The drivers already put
the right one into the contact point. What is missing is the member `PB-178` is about.

## Work to do

- Drop the parent harness's identity and messaging variables in every driver's
  `SESSION_ENV_DROP`. A participant must not be able to read its parent's session at all — not
  only must the mechanism not use it.
- Decide what `sessionIdentity()` answers on the MCP path, where there is nothing to read. That
  is `PB-178`'s member; this card must not paper over it with a second environment read.
- A check that fails when a parent variable survives into a participant's environment, for each
  driver that drops one.

## Out of scope

- The identity member itself — `PB-178`.
- Variables a participant legitimately needs (`PROMPTOBUS_HOME`, `PROMPTOBUS_ROLE`,
  `PROMPTOBUS_TASK`), which the mechanism sets deliberately.

## Verification

- `sessionIdentity()` inside a participant never returns the orchestrator's id.
- The parent's messaging socket and token are absent from a participant's environment.
