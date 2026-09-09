# PB-150 · The static APPROVE table computes both currentTime/read replies once at module load, so the rare deny path returns the holder process's boot-time timestamp instead of the current time

- **Order:** 810
- **Scope:** `lib/codex-session.js` (`APPROVE`, `decideApproval`, `onServerRequest`)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

lib/codex-session.js:438-446 defines the Codex holder's approval table, `APPROVE`, as a plain object literal — every value in it is computed once, at module load. The `currentTime/read` row (line 446) is: `'currentTime/read': { ok: { currentTime: new Date().toISOString() }, no: { currentTime: new Date().toISOString() } }`.

The `ok` half is provably dead. `decideApproval` (lines 498-...) allows `currentTime/read` outright at line 506 (`if (method === 'mcpServer/elicitation/request' || method === 'currentTime/read' || method === 'item/tool/requestUserInput') return { allow: true };`), unless `looksLikeConfigRead` (line 449) matches first. `onServerRequest`'s allow branch (lines 796-802) special-cases the method before ever reading the table: `if (msg.method === 'currentTime/read') return { currentTime: new Date().toISOString() };` on line 801, one line above the fallback `return known.ok;` on line 802 — so `known.ok` for this method is unreachable code.

The `no` half is reachable and wrong. `looksLikeConfigRead(method, params)` (lines 449-452) flags a call as a config read when the method itself is `'config/read'` OR when `JSON.stringify(params ?? {})` contains the substring `'config/read'` — a blind text match over the whole params blob, not scoped to the method name. A `currentTime/read` call whose params happen to serialize with that substring anywhere inside them (an ATI-formatted path, a filename, a quoted string) triggers `decideApproval`'s line 499 branch, `return { allow: false, why: ... }`, without setting `unknown`. `onServerRequest` then falls into `if (!decision.allow)` (lines 796-798) and returns `known?.no ?? { decision: 'denied' }` at line 798 — the `currentTime` value captured at import time, which is the holder process's boot timestamp, stale for as long as that process has lived (a holder is long-lived by design, per docs/reference/03-cli.md § "The Codex holder": it outlives the command that started it and is watched every five seconds rather than restarted per turn).

Not tracked: `grep -rln "currentTime" docs/backlog docs/archive` returns nothing, so this is not an open or already-closed entry, and no ADR, comment, or later commit addresses it (`git log --oneline -- lib/codex-session.js` shows only unrelated PB-3/PB-15/PB-26-28/PB-39 work). Not deliberate either: nothing near the `APPROVE` table or `looksLikeConfigRead` explains why `currentTime/read` carries a static value on both branches. The trigger for the wrong `no` path is narrow — it needs `config/read` to appear as a literal substring inside `currentTime/read`'s own params, which callers do not naturally produce — so the defect is real but low-probability in practice.

## Work to do

- Turn the `currentTime/read` row in `APPROVE` (lib/codex-session.js:446) into something computed per call rather than once at import — either drop the row entirely (both branches already have, or can gain, their own special case) or replace its value with a function invoked at read time.
- Add a `currentTime/read`-specific branch to `onServerRequest`'s deny paths (the `known?.no` returns at lines 793 and 798) that computes a fresh `new Date().toISOString()`, mirroring the fresh computation the allow branch already does at line 801 — so both the allow and the rare deny path answer with the real current time instead of only one of them.
- Note in a comment beside the `APPROVE` table why `currentTime/read` cannot be a static row like its neighbours (its value is time-dependent; the other six rows are fixed decision strings).

## Out of scope

- Narrowing `looksLikeConfigRead`'s substring match to stop misclassifying a `currentTime/read` call as a config read in the first place — that changes the deny heuristic itself and is a separate, larger question about false positives across all methods, not just this one.
- Any change to the other six rows of `APPROVE` — their `ok`/`no` values are fixed decision strings with no time dependency, so the static-table shape is correct for them.

## Verification

- A unit test constructing a `currentTime/read` call whose `params` serializes to contain the substring `config/read`, asserting the holder's `no` reply carries a timestamp within a few seconds of `Date.now()` rather than the value captured at module load (spawn the holder, wait, then trigger the call — the stale value would differ by more than the wait).
- `node --check lib/codex-session.js` and the existing Codex holder suite (`test/model-routing-adapter-codex.test.mjs` and friends) stay green.
- `backslop lint` and `npm run audit` exit 0.

## Triage — 2026-09-07

- **Track:** C — Codex session lifecycle.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/codex-session.js:438`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** The timestamp in the static table is code-supported. First establish that the deny path is reachable for currentTime/read; do not invent a new observable failure if only a redundant row needs removal.
