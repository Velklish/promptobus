# PB-14 · Adapter contract, budgeted parallel preflight, and the availability cache with TTL

- **Order:** 40
- **Scope:** [03-cli](../../reference/03-cli.md), [02-host](../../reference/02-host.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-12

## Context

Stage 3 of the routing plan, the harness-neutral part: one adapter contract that each driver implements, a preflight that runs the adapters in parallel under one time budget, and a cache so that `spawn` does not re-probe three harnesses on every call. The cache is the one file here that can leak: it must hold no prompt, token, email or open account id.

## Work to do

- Adapter contract in `src/driver.ts` (or a sibling module): `probe({ host, timeoutMs, refresh })` → `{ state, reason, message, checkedAt, source, resetAt?, models?, windows? }` with `state ∈ available | exhausted | unavailable | unknown` and reason codes from PB-11. `lib/drivers.js` exposes the adapter per driver; a driver without one reports `unknown` / `probe_failed`.
- Preflight: all adapters in parallel, total budget 15 s, a late adapter reports `probe_timeout`; result is the availability snapshot the resolver reads.
- Cache at `<promptobusHome()>/model-routing/cache.json`, mode 0600, written atomically. TTLs: auth and inventory 1 h, limit windows 60 s, confirmed exhaustion until known reset, exhaustion without reset until manual clear, transient failure 5 min. Account separation, if needed, by an opaque local fingerprint.
- `--refresh` ignores matching entries; `--clear-exhausted <harness>` drops the manual or reset-less exhaustion; a no-write mode for `--dry-run` (PB-21 wires the flag).
- Late-start classification hook: a driver that hits a limit error while starting reports it, and the cache marks the tuple or harness `exhausted` (`manual_exhaustion` or `subscription_exhausted` by evidence).
- Stub adapters for the suite: a slow one, an exhausted one, one without auth.

## Out of scope

- The three real adapters — PB-15, PB-16, PB-17.
- Scoring — PB-18.

## Verification

- Tests: state transitions, each TTL, budget with a slow stub (the whole preflight ends by 15 s and names the slow harness), cache permissions and content (no secrets by grep of the fixture), no write in no-write mode, `--clear-exhausted` and `--refresh` effects.
- Mutation probe: raise the budget in code, the budget test goes red; drop the `0600`, the permission test goes red.
