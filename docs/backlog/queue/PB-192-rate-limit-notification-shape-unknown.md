# PB-192 · 147 live rate-limit notifications carry neither shape the holder reads, and the payload is recorded nowhere

- **Order:** 90
- **Scope:** `lib/codex-session.js` (:1128, :291, :296, the `account/rateLimits/updated` branches at :1127 and :1146), `lib/model-routing/adapter-codex.js` (the notification fallback), [03-cli](../../reference/03-cli.md) § Codex availability
- **Created:** 2026-09-12, orchestrator's measurement during the 0912c backlog run
- **Dependencies:** `PB-24.1` is the neighbouring card and is **not** unblocked by this one — see below

## The measurement

Three live Codex participants, 0912c run, their holder journals in `~/.agents/codex/sessions/`:

```
grep -h 'account/rateLimits/updated' worker-*0912-09*.log | sed 's/.*updated //' | sort | uniq -c
    147 usedPercent=?
```

**One hundred and forty-seven notifications, and not one parsed value.** The holder's line is
`lib/codex-session.js:1128`:

```js
log(`event ${msg.method} usedPercent=${p.primary?.usedPercent ?? p.usedPercent ?? '?'}`);
```

So the payload carries neither `p.primary.usedPercent` nor `p.usedPercent`. The same two shapes are
what the exhaustion check reads — `:291` `windows.some((w) => Number(w.usedPercent) >= 100)` and
`:296` `snap.primary?.usedPercent ?? snap.usedPercent`. On this binary both read `undefined`.

**And what the payload does carry is unknown, because nothing keeps it.** The holder logs the
summary and drops `p`; the session record (`~/.agents/codex/sessions/<ref>.json`) holds
`ref, cwd, bin, role, startedAt, threadId, holderPid, appPid, rpcSocket, state, sandbox,
approvalPolicy, model, effort` and no limits at all; the task store has no `rateLimits` anywhere
(`grep -rl` over the task directory → nothing).

## What this does and does not cost today

**Does not.** `models` is unaffected and its numbers are sound: the Codex adapter's ordinary path is
the request `account/rateLimits/read`, which answers properly — this run read Codex `primary` as
`0.0% used` repeatedly, and the window's `resets` timestamp is real.

**Does.** The notification is the **fallback** path, taken when a binary lacks the request
([03-cli](../../reference/03-cli.md) § Codex availability). On such a binary the fallback would today
produce no percentage at all, silently, and the exhaustion check at `:291` would never fire. Nobody
would see it: the holder prints `?` and the line looks like ordinary telemetry.

## Why `PB-24.1` is not closed by this

`PB-24.1`'s return condition is *"a captured `account/rateLimits/updated` payload from a live Codex
session (the driver's log can record one)"*. That condition has **not** fired — the opposite is what
was measured. The driver's log **cannot** record one as built: it reduces the payload to one
interpolated field and keeps nothing else. `PB-24.1` stays deferred, and this card is the reason it
cannot leave that state by itself.

## Work to do

- Record the payload of `account/rateLimits/updated` somewhere a person can read it — at minimum once
  per holder, at debug level, whole. Until then no card about this notification can be closed by
  measurement, only by guessing.
- With a recorded payload in hand, decide whether the two shapes the code reads are wrong, stale, or
  simply absent on codex-cli 0.146.0, and fix the reader or state the boundary in 03-cli.
- The exhaustion check at `:291` deserves the same question: it reads `usedPercent` off window
  objects, and whether those windows ever arrive by this route is unmeasured.

## Out of scope

- The request path `account/rateLimits/read` and the numbers `models` prints from it: measured
  working this run, untouched here.
- The window **duration** question — that is `PB-24.1`'s subject, and it stays there.
