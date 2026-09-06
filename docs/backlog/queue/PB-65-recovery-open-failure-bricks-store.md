# PB-65 · Fan-out recovery at engine open lets its failure escape and drops its result: one unfinishable intent bricks every bus command, and an isolated record is reported to nobody

- **Order:** 90
- **Scope:** `src/v1/engine.ts`, `src/v1/messages.ts`, `src/v1/artifacts.ts`, `lib/store.js`, [04-protocol](../../reference/04-protocol.md) § Engine
- **Created:** 2026-09-06
- **Dependencies:** PB-66

## Context

`src/v1/engine.ts:386` — `if (recover) engine.recover();` — is neither guarded nor read.

The call can throw. `recover()` → `recoverTask` (`src/v1/messages.ts:575`) → `completeFanout` (`:266`) → `materialize`/`linkOnce` → `linkFailure` (`src/v1/artifacts.ts:165-181`), which turns a hard-link refusal (`EXDEV`, `ENOTSUP`, `EPERM`, `EACCES`, `EMLINK`) into a `PromptobusError('link-refused', …)`; a bare, unclassified errno propagates as-is. Either way `openEngine` throws, and `lib/store.js:205-212`'s `bus()` opens the engine on the first store touch of every process and caches only AFTER a successful open — so nothing is confined to the send that first hit the refusal.

Reproduced on the current tree: chmod 0o500 on one inbox, one send, then reopen. Result: `SEND refused: link-refused`, then `OPEN with recover THREW: PromptobusError link-refused hard link was not created (EACCES)`, while `openEngine({ recover: false })` opens and reads the journal fine.

Everything that opens the engine goes down with it: `listTasks` (`lib/store.js:444-445`, feeding `status` and `prune` via `lib/prune.js:70`), `history` (`lib/store.js:972`), the warden (`lib/warden.js:203`), and the MCP server. `prune` — the one command that could drop the offending task — is unreachable too, so the store needs manual repair to recover at all.

This contradicts what the code states twice: `src/v1/artifacts.ts:171-173` — "fan-out breaks on the step, the intent stays open, and recovery will take it to the end when the condition is lifted"; `lib/store.js:442-443` — "one damaged task would otherwise kill every bus command". `test/v1-races.test.mjs:415-419` does not cover this path — it opens with `recover: false` while the refusal holds and restores the permission before the next normal open.

The result is lost on top of the open being lost: `grep -rn '\.recover(' lib/ bin/ src/` returns only `engine.ts:386`, so this implicit call is the whole of production recovery, and its `RecoverResult { repairs, events, broken }` is discarded. An intent isolated into `broken/messages/` after a crash inside the commit point (`src/v1/messages.ts:611-621`) leaves no log line, no exit code, and no field a person can query.

## Work to do

- Stop the open-time `recover()` call from aborting the open: collect a per-task failure into the result instead of letting it escape — a `failed` list beside `repairs`/`broken` on `RecoverResult` — so an unfinishable fan-out leaves its intent for the next attempt, as `artifacts.ts:171-173` already promises, and read-only commands keep working on a store whose links are refused.
- Report the collected result somewhere a person sees it: do the open-time recovery in `lib/store.js`'s `bus()` (open with `recover: false`, call `recover()` explicitly, report through the existing `warn` in `lib/util.js`) instead of adding a callback option to `openEngine` for a single caller. The exact shape (return value vs. callback) is the implementer's call as long as the failure surfaces.
- Add the missing case to `test/v1-races.test.mjs`: open with recovery ON while the link refusal still holds, and assert `status`/`history`/`prune` still succeed instead of throwing.
- Update `docs/reference/04-protocol.md` § Engine (and any recovery prose in `docs/reference/03-cli.md`) to state the corrected contract: an unfinishable intent surfaces as a reported warning at open, not as a thrown error that blocks every command.

## Out of scope

- Extending `linkFailure`/`LINK_REFUSALS` to cover more errno codes — untouched; this is about what happens after a refusal is already classified, not about the classification itself.
- Retry or backoff policy for a refused link — recovery already retries on every open by design; this only stops that retry's failure from becoming a store-wide outage.

## Verification

- New `test/v1-races.test.mjs` case: with a link refusal held, `openEngine({ recover: true })` returns instead of throwing, and `status`/`history`/`prune` on that store succeed.
- Manual repro from this finding (chmod 0o500 on one inbox, refused send, reopen) no longer throws on open; the failure appears in the reported recovery result instead.

## Triage — 2026-09-07

- **Track:** S — Store integrity and public engine.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `src/v1/engine.ts:386`, `src/v1/messages.ts:575`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep failure local to the affected recovery operation, with visible recovery diagnostics. Do not blanket-catch programmer errors or silently declare a broken recovery successful.
