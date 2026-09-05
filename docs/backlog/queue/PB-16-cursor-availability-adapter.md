# PB-16 · Cursor availability adapter

- **Order:** 60
- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-14

## Context

Cursor's `agent` CLI has `agent status` (auth) and `agent models` (inventory with effort suffixes and a `NO ZDR` mark on some ids). There is no quota API the plan could find, so the remaining limit is `unknown`. The owner runs `agent login` before a live acceptance; the adapter never drives an interactive login. Neighbour in triage: PB-7 (a Cursor participant in a long reasoning phase looks dead) — different subject, do not merge; the adapter must not treat a slow `agent` call as `unavailable` without the timeout reason.

## Work to do

- `agent status` → `available` / `unavailable` (`not_authenticated`, `binary_missing`), with the exact strings measured and stubbed in tests.
- `agent models` → inventory; the model id is the full id including the effort suffix (`lib/driver-cursor.js` around line 140); the `NO ZDR` mark travels into the snapshot as a flag on the model row so that an overlay can deny it — the package itself does not judge it.
- Remaining limit → `unknown` / `quota_unknown`.
- Late-start quota errors from the driver's start path update the cache (PB-14 hook).

## Out of scope

- Liveness of a running Cursor participant — PB-7.
- Deciding which Cursor models a consumer allows — that is overlay policy.

## Verification

- Adapter tests on stubbed `agent status` / `agent models` output, including a `NO ZDR` row and a timeout.
- Live probe on the owner's machine after `agent login`, recorded in the result.
