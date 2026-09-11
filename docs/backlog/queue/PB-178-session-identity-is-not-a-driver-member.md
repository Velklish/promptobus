# PB-178 · `sessionIdentity` reads one harness's environment variable directly, while every other harness fact is a driver member

- **Order:** 140
- **Scope:** `lib/store.js` (`sessionIdentity`), `lib/drivers.js` (the driver contract),
  the three drivers, [02-host](../../reference/02-host.md), ADR-034
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Measured 2026-09-12 by a worker establishing what gives an orchestrator its identity. The
answer is one line:

```js
// lib/store.js:173
sessionIdentity = env.CLAUDE_CODE_SESSION_ID?.trim() || null
```

And it is not a corner: `grep -ho "sessionIdentity(" lib/*.js | wc -l` → **23 calls across 8
modules** — store 10, warden 3, dismiss 2, done 2, review 2, spawn 2, guard 1, status 1. The
mirror measurement: `grep -n "identity\|sessionId" lib/drivers.js` → **nothing**.

**The driver contract has no identity member at all.** Permission-mode dictionary, effort
levels, dropped environment variables, deny list, knock channel, default model — every one of
those became a driver member under ADR-034. Identity alone stayed behind, and the
harness-neutral core reads one harness's variable directly.

So the statement of the problem is not "add support for Cursor". It is that ADR-034 has a hole
in it, and `sessionIdentity` belongs beside `knockChannel`.

**What it costs today.** A session of any other harness has no identity, so mailbox ownership
cannot be established for it: `promptobus status` shows `orchestrator · owner <id>` empty, and
`claim` has nothing to compare against and therefore cannot refuse a foreign session. Those two
are also the observable the fix is checked against.

## Work to do

- Make identity a driver member. What each driver answers with is its own question — an
  environment variable where one exists, something else where it does not — and a driver that
  cannot answer must say so rather than return a plausible value.
- Decide what the core does when the driver has no identity to give: today the `null` path
  exists and is silently the same as "not a Claude session", which is how this went unnoticed.
- The two observables must hold for a session of every declared harness: `owner` in `status` is
  not empty, and `claim` on a foreign session refuses.

## Out of scope

- Delivery to an orchestrator without a socket — a neighbouring question with its own card in
  the consumer's tracker.
- Which variable each harness offers: that is the driver's business, and answering it here
  would rebuild the same hole one level down.

## Verification

- A session of each declared harness has an identity, or its driver says it has none.
- `claim` refuses a foreign session for every harness, not only for one.
