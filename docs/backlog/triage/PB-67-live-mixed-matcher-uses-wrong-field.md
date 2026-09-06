# PB-67 · live-mixed.mjs matches inbox messages on m.from, a field protocol v1 messages do not carry, so all five mailbox verdicts of the mixed lineup go red after 30 minutes of waiting

- **Scope:** `scripts/live-mixed.mjs`, `test/scenario.mjs`, [04-protocol](../../reference/04-protocol.md) § Message types
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Three matchers in the live script read a field that does not exist on a stored v1 message:

- `scripts/live-mixed.mjs:218-219` — `const said = (from, type, mark) => orchInbox().find((m) => m.from === from && m.type === type && String(m.body ?? '').trimStart().startsWith(mark)) ?? null;`
- `scripts/live-mixed.mjs:345` — `.find((m) => m.from === REVIEWER && m.type === 'result')`
- `scripts/live-mixed.mjs:391` — `.find((m) => m.from === REVIEWER && m.type === 'result' && ...)`

`orchInbox()` (`:216`) is `store.glanceInbox(home, TASK, 'orchestrator')`, which returns raw v1 records. The schema forbids the field these matchers read: `schemas/v1/message.schema.json` requires `sender` (not `from`) and sets `additionalProperties: false`. `lib/store.js:873`'s `sendMessage` passes `from: addrDir(from)` into the bus, which stores the value as `sender`.

Probed against the real store (the same `lib/store.js` module `test/scenario.mjs:64` imports): after `sendMessage` from `worker:live` to `orchestrator`, `glanceInbox` returns keys `["protocolVersion","id","task","sender","recipients","type","body","ts"]`; `m.from` is `undefined`, `m.sender` is `"worker-live"`. `m.from === 'worker:live'` is false; `m.sender === store.addrDir('worker:live')` is true.

`waitFor` (`test/harness.mjs:528-536`) returns the last falsy probe on timeout instead of throwing, so the run does not break — it waits out every budget: 300s (`:310`), 600s (`:345`), 300s (`:362`), 600s (`:390`) — 30 minutes total — and reports five red verdicts (`:311, :347, :349, :363, :393`) while spending a Cursor and a ChatGPT account limit to produce them.

The correct matcher already exists one file away, unused here: `test/scenario.mjs:551` — `const sentBy = (m, addr) => m?.sender === store.addrDir(addr);`.

## Work to do

- Export `sentBy` from `test/scenario.mjs` (it is local today; `store`, `WORKER`, `REVIEWER`, `MARK` are already exported from the same file) and use it in `scripts/live-mixed.mjs` at lines 219, 345 and 391, so the two files cannot drift apart on this again.
- If the export is not wanted, spell it inline in `live-mixed.mjs` as `m.sender === store.addrDir(from)` at all three call sites.
- Add a stub-mixed-lineup check (natural home: `test/promptobus-mixed.test.mjs`) that a message sent through `store.sendMessage` is found by the script's `said()`/reviewer matchers — proving the predicate off the live path, since the script itself is not run in `npm test`.

## Out of scope

- waitFor's return-last-falsy-instead-of-throwing behaviour (`test/harness.mjs:528-536`) — deliberate (a step that does not arrive must still produce a red verdict, not a file abort) and stays; only the predicate that made every verdict red regardless of it is fixed.
- scripts/live-cursor.mjs's mirror-image defect (its step-5 predicate goes green on no reviewer message at all, a different mechanism) — filed separately in this same batch.

## Verification

- The new stub-mixed check in `test/promptobus-mixed.test.mjs` passes: a message sent via `store.sendMessage` from a worker/reviewer address is found by `said()`/the reviewer matcher.
- One live `node scripts/live-mixed.mjs` run on the owner's accounts: the five verdicts that were red (lines 311, 347, 349, 363, 393) turn green, and the run no longer spends its full 30-minute timeout budget waiting on matches that can never succeed.
