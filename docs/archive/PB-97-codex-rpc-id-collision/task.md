# PB-97 · CodexRpc dispatches on the pending-id pool before `method`, so a server-to-client request whose id collides with an outstanding client request is swallowed as its reply — the approval is never answered and the turn hangs

- **Scope:** [03-cli](../../reference/03-cli.md) § The Codex holder, `lib/codex-rpc.js`, `lib/codex-session.js`, `test/harness-codex.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none
- **Taken:** 2026-09-08

## Context

`dispatch` in lib/codex-rpc.js checks the pending-request pool before it looks at the message shape:

```
29  if (msg.id !== undefined && pending.has(msg.id)) {
30    const { resolve } = pending.get(msg.id);
31    pending.delete(msg.id); resolve(msg); return;
32  }
35  if (msg.id !== undefined && msg.method) {   // server-to-client request — checked second
```

A JSON-RPC response never carries `method`, and each direction — client-to-server, server-to-client — owns its own id space (client ids come from the module-level counter `let nextId = 1` at line 9), so a collision is a protocol possibility, not something guarded against elsewhere.

Reproduced against the real module (PassThrough streams, scratchpad probe): with `turn/start` outstanding as client id 1, feeding `{"id":1,"method":"item/commandExecution/requestApproval"}` resolves the `turn/start` promise with the request object itself, the server-request handler registered via `onServerRequest` runs 0 times, and the only bytes written back to app-server are the original outgoing `turn/start` request — no reply to the approval is ever sent.

`handleOp('rpc')` (lib/codex-session.js:875-878) then sees no `ans.error` on the malformed "response" and returns `ans.result ?? {}` — an empty object — so the caller is told the RPC succeeded while app-server is left waiting for an approval reply that never comes. This is exactly the failure the file's own header (lib/codex-rpc.js:6-7) names: "Without a reply to such a request the turn stalls forever."

Unmeasured: how codex-cli 0.146.0's app-server numbers its outbound request ids in practice, and how often they land in the client's low integer range — the protocol (`codex app-server generate-ts`) declares `RequestId = string | number` with no separation enforced between directions. The window is not permanently open: app-server typically replies to `turn/start` promptly, so `pending` is usually near-empty; the exposed case is a wake, where lib/driver-codex.js:273-278 holds a `turn/start` pending for `turnWaitMs()` while a previous turn is still running and emitting approvals — the neighbouring PB-41 hangs measured on this exact path, though their handler DID run (an allow was logged), so the id-dispatch order was not the cause there.

No test exercises this: `grep -rn CodexRpc test/` matches only files that import it, not a test naming it, and the app-server stub in test/harness-codex.mjs:266 allocates server-request ids as `srv-${randomUUID()}` — a string space disjoint from the client's integer counter, so the suite cannot reach this branch as written.

## Work to do

- In `dispatch` (lib/codex-rpc.js:27-41), check `msg.method` first: a message with `method` is a request or notification regardless of whether its id happens to be in the pending pool; only an id without `method` is treated as a response.
- Log an unmatched response (`onLog?.('orphan', msg)`) instead of silently dropping it, for the case where a response id has no pending entry.
- Add the module's first unit test: a client request outstanding, a server request fed with the same integer id, asserting the server handler ran and a reply was written while the client request stays pending.

## Out of scope

- Namespacing outgoing client ids (e.g. `c-1`, `c-2`) to make a collision structurally impossible — a defensible follow-up, but the dispatch-order fix alone closes the bug regardless of id shape.
- Measuring codex-cli's actual id-numbering scheme — the fix does not depend on knowing it.

## Verification

- New unit test: client request pending on id 1, server request fed on id 1 — the server handler runs and a reply is written back; the client request's promise stays pending until its own reply arrives.
- `npm test` green; `test/promptobus-driver-codex.test.mjs` unaffected.

## Triage — 2026-09-07

- **Track:** C — Codex session lifecycle.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/codex-session.js:875`, `lib/codex-rpc.js:6`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Request/response dispatch ordering is visible in lib/codex-rpc.js. A pending-id collision can be reproduced with in-memory streams; it is not yet proven to be the cause of the historical PB-41 hang.
