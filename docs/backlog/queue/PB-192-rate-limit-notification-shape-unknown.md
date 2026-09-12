# PB-192 · The holder's rate-limit notification journal must retain the full payload

- **Order:** 30
- **Scope:** `lib/codex-session.js` (`account/rateLimits/updated` journal and session-record branches), `lib/model-routing/adapter-codex.js` (the notification fallback), [03-cli](../../reference/03-cli.md) § Codex availability
- **Created:** 2026-09-12, orchestrator's measurement during the 0912c backlog run
- **Dependencies:** `PB-24.1` is the neighbouring card and is **not** unblocked by this one — see below

## The measurement

Three live Codex participants, 0912c run, their holder journals in `~/.agents/codex/sessions/`:

```
grep -h 'account/rateLimits/updated' worker-*0912-09*.log | sed 's/.*updated //' | sort | uniq -c
    147 usedPercent=?
```

**One hundred and forty-seven notifications, and not one parsed value.** The old holder line
reduced the payload to the primary/top-level `usedPercent` lookup and printed `?`. The same two
shapes are what the exhaustion check reads — :291 `windows.some((w) => Number(w.usedPercent) >= 100)`
and :296 `snap.primary?.usedPercent ?? snap.usedPercent`. On that binary both read undefined.

The initial card also said the payload was kept nowhere. The current code already writes the latest
notification params as `rateLimits` in the session record (`lib/codex-session.js`, the
`account/rateLimits/updated` branch), but that is one latest-state object, not readable evidence of
each notification. The holder journal was the missing per-notification record.

## What this changes

The holder now writes the complete notification params at the debug journal boundary:

```
debug event account/rateLimits/updated payload=<JSON.stringify(p)>
```

The session record continues to carry the latest `rateLimits` payload. The two representations have
different jobs: the journal lets a person inspect every notification, while the record answers the
holder's current state without replaying the log. No payload fields are renamed or interpreted by this
change.

The worker's targeted run also wrote this line before a later `listen EPERM` class-B abort; the event log is therefore available even when the process dies, but that run is not a green file verdict.

The Codex driver test now asserts the complete fixture payload, including both `usedPercent` shapes,
`resetsAt`, `planType` and `rateLimitReachedType`; the old method-name check remains as a separate
verdict. The request path `account/rateLimits/read` is unchanged.

The additional holder-level verdict is a duplicate for probe reachability only: it exercises the same journal contract in a short stand when the larger driver file hits class B, not a second copy of the contract to merge or a replacement for the driver's own check.

## What this does and does not cost today

**Does not.** `models` is unaffected and its numbers are sound: the Codex adapter's ordinary path is
the request `account/rateLimits/read`, which answers properly — this run read Codex `primary` as
`0.0% used` repeatedly, and the window's `resets` timestamp is real.

**Does.** The notification is the **fallback** path, taken when a binary lacks the request
([03-cli](../../reference/03-cli.md) § Codex availability). The holder now preserves evidence for
that path, but this pass does not reinterpret the notification or change the exhaustion reader.

## Why `PB-24.1` is not closed by this

`PB-24.1`'s return condition is *"a captured `account/rateLimits/updated` payload from a live Codex
session (the driver's log can record one)"*. That condition has **not** fired in the live run quoted
above — the old journal contained only `usedPercent=?`. The new diagnostic line enables the next live
capture, but no paid turn was spent in this pass and no live notification payload was captured here.

The fixture proves only that the holder writes and the test reads the shape supplied by the stand. It
does not prove that codex-cli 0.146.0 sends the same shape. The two reader questions remain open:
whether the notification has primary/flat windows and whether the exhaustion check should read them
on this fallback path. `PB-24.1` remains deferred; this card remains in the queue for that measured
follow-up.

## Out of scope

- The request path `account/rateLimits/read` and the numbers `models` prints from it: measured
  working this run, untouched here.
- The window **duration** question — that is `PB-24.1`'s subject, and it stays there.
