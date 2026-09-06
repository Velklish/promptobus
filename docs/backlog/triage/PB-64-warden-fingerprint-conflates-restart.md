# PB-64 · The contact-point fingerprint conflates a turn end with a session restart: the warden re-knocks inside the retry threshold and repeats the whole mailbox on every turn end

- **Scope:** `src/supervisor.ts`, `src/sidecar.ts`, `lib/driver-claude.js`, `lib/driver-cursor.js`, `lib/driver-codex.js`, `lib/guard.js`, `lib/server.js`, [03-cli](../../reference/03-cli.md) § Guard and warden
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`src/supervisor.ts:623-624` builds the fingerprint from the hand-over time as well as the socket address:

    const print = endpoint?.socket ? `${endpoint.socket}#${endpoint.at ?? ''}` : null;
    const moved = print !== null && was.wake !== undefined && print !== was.wake;

and `:698` uses that one flag to decide how much of the mailbox to repeat, inside the branch at `:683` (`!Number.isFinite(triedAt) || grew || moved || (stale && !busy)`):

    const upTo = moved ? null : was.knockedTo ?? null;

`src/sidecar.ts:162` rewrites the wake record — stamping a fresh `at` — whenever socket, token OR **pid** differ from the stored one:

    if (was && was.socket === next.socket && was.token === next.token && was.pid === next.pid) return was;

That makes `moved` fire on the ordinary path of the Claude driver, not only on a genuine restart. The Stop hook that calls `registerWake` (`lib/guard.js:319`) is its own short-lived process, while the participant's bus server calls the same function from a long-lived process (`lib/server.js:84`); Claude's socket string carries no turn counter, so only the pid differs between the two callers, and every ordinary turn end rewrites the record. Cursor and Codex do not hit this the same way, but by design, not by accident: their `socket` already carries a turn counter (`${file}#${turns}` at `lib/driver-cursor.js:568`, `${record.rpcSocket}#${Number(record.turns) || 0}` at `lib/driver-codex.js:158`), and the comment at `lib/driver-cursor.js:540-548` documents this as the intended way to make the warden knock immediately at turn end.

Reproduced against the shipped `lib/warden.js`: three unread messages, socket and token unchanged, only the pid rewritten. The first knock lands; a same-address re-handoff at +11s — inside `KNOCK_RETRY_SEC` (120s) — still produces `notification worker:a: unread 3, knock 2 (contact point rewritten)`, and its postcard repeats all three messages, identical to the first, because `upTo` was reset to `null` by `moved`. On Claude the same flag also bypasses the `busy` gate (`:683`, same `||`), so a turn end with unread mail costs the guard's turn return AND a socket knock for the same message.

`node --test test/promptobus-warden.test.mjs` passes (236 assertions) without seeing this: its only `moved` case (`:315-325`) changes the socket path itself, never a same-address, pid-only rewrite.

The comments at `:620-622` and `:696-699` state the equation this flag is built on — the participant rewrote its contact point, therefore the session restarted — and that equation is false for the ordinary Claude turn-end path, which is the majority of shipped traffic.

## Work to do

- Drop the hand-over time from the fingerprint: `const print = endpoint?.socket ? endpoint.socket : null;`. A driver that wants an immediate knock at turn end already encodes that in the socket string itself (Cursor and Codex append the turn counter for exactly this); a pid-only rewrite of the same Claude socket then falls through to the ordinary `grew`/`stale`/`busy` thresholds instead of being read as a move.
- Split the mailbox cutoff from `moved`: track the session behind the last knock (a `wakeSession` field next to `wake` in `HealthMark`, `src/supervisor.ts:65`) and repeat the whole mailbox only on a genuine restart — `endpoint.session !== was.wakeSession`. All three drivers already carry `session` into `writeWake` (`lib/driver-claude.js:610`, `lib/driver-cursor.js:568`, `lib/driver-codex.js:158`), so no new data collection is needed.
- Fix the comments at `:620-622` and `:696-699`, which currently state the false equation between a rewritten contact point and a session restart.
- Add two cases to `test/promptobus-warden.test.mjs` next to the existing `moved` case: a pid-only re-handoff of the same socket must not knock inside `KNOCK_RETRY_SEC`, and a turn-counter rewrite (Cursor/Codex style) must still knock immediately but carry only what arrived after `knockedTo`.
- Update any warden/knock prose in `docs/reference/03-cli.md` § Guard and warden that currently implies a rewritten contact point always means a restart.

## Out of scope

- The immediate knock on an actual socket rewrite (Cursor and Codex's turn-counter suffix) — deliberate, stays; only the false positive on a same-address, pid-only rewrite and its effect on the mailbox cutoff are in scope.
- The `busy` gate itself (`stale && !busy`) — untouched; only its bypass via the mis-set `moved` flag on Claude is fixed by removing pid from the fingerprint.

## Verification

- `node --test test/promptobus-warden.test.mjs` stays green, plus the two new cases pass: a pid-only rewrite of an unchanged Claude socket inside `KNOCK_RETRY_SEC` produces no second knock, and a Cursor/Codex-style socket rewrite still knocks immediately with only the messages after `knockedTo`.
- Manual repro from this finding (three unread, pid-only rewrite at +11s) no longer produces a second `(contact point rewritten)` knock inside the retry threshold.
