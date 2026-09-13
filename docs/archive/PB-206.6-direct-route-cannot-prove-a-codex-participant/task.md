# PB-206.6 · The direct route refuses every real Codex participant

- **Order:** 30
- **Scope:** `src/mcp/server.ts` (`serve`, `promptobus_send`), `lib/store.js` (`requireDirectSender`, `sessionIdentity`), `lib/driver-codex.js` and `lib/driver-cursor.js` (participant MCP env), `test/promptobus-mcp.test.mjs`, `docs/reference/02-host.md` § Session identity
- **Created:** 2026-09-13
- **Dependencies:** PB-206 (the route this card guards is the one that card shipped)

## Context

Found by the isolated reviewer on the PB-206.2 diff; the defect itself belongs to PB-206, which shipped the direct `worker`↔`approver` route. The route is fail-closed on an identity the participant MCP server cannot obtain, so on the Codex path it refuses every call.

**Два места ниже цитируются блоком кода, а не блоком `quote`, и это вынужденно.** Блок `quote` сверяется с диском, а предмет карточки в том и состоял, чтобы этих строк не стало: после починки они исчезли, и сверка краснит `lint` у всякого, кто встанет на дерево с правкой. Класс заведён отдельной карточкой в трекере инструмента разметки.

The MCP server takes its identity from the environment of its own process:

`src/mcp/server.ts`, до правки:

```
    const identity = resolveIdentity();
```

`resolveIdentity` fills `session` from `sessionIdentity(env)`, which asks the driver registry to read a harness variable out of that environment. The direct route then demands it and refuses when it is absent:

<!-- quote:../../../lib/store.js -->
  if (!session) {
<!-- /quote -->

<!-- quote:../../../lib/store.js -->
      + 'the calling harness supplied no session identity');
<!-- /quote -->

The repository's own measurement says that environment never carries one. `docs/reference/02-host.md` § Session identity records that the member answers for a command the session runs and not for the session's own MCP server: the harness hands an MCP server child eleven variables with nothing harness-specific among them, so on that path identity from the environment is impossible rather than unsupported. What the driver does inject into the participant's bus server is a pointer to its own session record, not a harness variable:

<!-- quote:../../../lib/driver-codex.js -->
    const extra = { [SESSION_ENV_VAR]: sessionFile(ref) };
<!-- /quote -->

So every real participant tool call arrives with `session === null` and is refused, while the tool still advertises direct traffic. The suite does not catch it because the MCP test supplies an identity the real child never has:

`test/promptobus-mcp.test.mjs`, до правки:

```
    CLAUDE_CODE_SESSION_ID: 'direct-worker-session',
```

Not yet reachable in practice: nothing lifts an `approver` (PB-206.5), so no participant can exercise the route today. That is why this is a card and not a stop-the-line defect — but it must close before an approver is liftable, or the fourth role ships with a door that is welded shut.

## Work to do

- Give the participant MCP server a proof of identity it can actually present, task- and address-bound. The driver already injects one — the session-record pointer quoted above, which both the Codex and Cursor drivers write and already read back elsewhere; resolving the caller through that record is the narrow fix, and it keeps the gate fail-closed rather than widening it.
- Decide whether the proof belongs to the driver contract (a member beside `identityVar` that answers for the MCP path) or stays a per-driver detail. The former is the shape `docs/reference/02-host.md` already argues for on the command path.
- Cover direct sends with the environment shape a real participant MCP child has — no harness variable present — for Codex and Cursor both. The current test proves only the Claude shape.

## Out of scope

- Widening or removing the gate. Refusing an unproven sender is the behaviour PB-206 chose deliberately; this card is about giving the honest sender something to show.
- Lifting an approver — that is PB-206.5.

## Verification

- A direct `worker`→`approver` send through an MCP server started with only the eleven-variable environment plus the driver's injected pointer succeeds; the same send with the pointer removed still refuses with the existing message.
- Mutation probe: break the new resolution and watch the added Codex-shape test redden, then restore.
- Gates green with numbers on the merged tree.
