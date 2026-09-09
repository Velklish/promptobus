# PB-45.1 · The snapshot path degrades a registry refusal to a bare `unknown`, so `promptobus status` still tells a person nobody can be asked

- **Scope:** `src/driver.ts`, `lib/status.js`, [02-host](../../reference/02-host.md), status/driver tests
- **Created:** 2026-09-07
- **Dependencies:** PB-45
- **Taken:** 2026-09-09

## Context

PB-45 made the registry readers and the direct driver operations — `inspect`, `stop`, `activate` — raise the `GateError` that names `PROMPTOBUS_<HARNESS>_HOME` and `harnessStateHome`, instead of answering `null` / `[]` / `gone` over a registry nobody opened. That is true of a direct call and is covered by its tests. It is not true of the path an operator actually uses.

`snapshotSessions` (`src/driver.ts:723-737`) wraps `driver.inspect(ref)` in a bare `catch` and substitutes the module-level `UNKNOWN` constant (`:699`), which carries `stall: null`. Every production reader of `inspect` goes through it: `promptobus status` (`lib/status.js:55`, `:64`, `:178`), `promptobus done` (`lib/done.js:311`) and the warden beat (`lib/warden.js:78`, `:237`, `:246`). So with no harness home declared, `status` prints a row for every Cursor and Codex participant and the refusal never reaches the person.

The second half of the chain closes it off independently. `lib/status.js:250` takes the `view?.state === 'unknown'` branch **before** any stall branch and prints a fixed sentence — "there is nobody to ask about it" — ignoring `view.stall` entirely. So attaching a reason to the view alone would still not surface it.

This is the same silence PB-2 was opened for and PB-45 set out to end; it changed label, from `gone` to `unknown`, not audibility. Measured during the acceptance of PB-45 on 2026-09-07 by reading both files at `fbbeae2`.

Letting the `GateError` through `snapshotSessions` is not the answer, and this entry does not ask for it. The recorded decision at `src/driver.ts:710-716` — "One invalid record has no right to take the whole snapshot with it" — exists so that one foreign harness cannot fell `status` printing, the `done` walk in the middle of cleaning foreign tokens, and the supervisor process itself. Trading a silent row for a dead command is worse.

The contract already blesses the shape this needs. The `sessionList` documentation (`src/driver.ts:59-68`) says of exactly this state that the flag "names the REASON for that unknown — so a second driver can declare it out loud rather than by a silent absence of the operation", and `SessionStall` (`:104-107`) is `{ kind, reason }`, described as "`kind` chooses the route, `reason` — words for a person". An unknown that carries its reason is the state the contract intends; the bare constant is what discards it.

## Work to do

- In `snapshotSessions`, distinguish a `GateError` from any other driver error: keep answering `unknown` and keep walking, but build the view with a `stall` carrying the refusal text instead of substituting the reasonless constant. Every other error keeps today's behaviour exactly.
- In `lib/status.js`, make the `unknown` branch print the carried reason when there is one, and keep "there is nobody to ask about it" for the case it was written for — a harness with no registry at all, where the unknown genuinely has no reason to give.
- State the corrected boundary in `docs/reference/02-host.md`, replacing the wording PB-45 left there: the snapshot degrades any driver error to `unknown` so one participant cannot take the whole snapshot down, and a refusal is carried into that unknown as its reason rather than dropped.

## Out of scope

- Propagating the `GateError` out of `snapshotSessions` — the recorded decision above stands, and this entry works within it.
- `promptobus done` and the warden beat beyond what falls out of the shared view: their own wording is their own question.
- The deliberate silencers on the wake path (`registerWake` in both drivers, `sessionPrefix` in the Codex driver) — they are load-bearing and PB-45 already corrected the documentation that misdescribed them.

## Verification

- With no `PROMPTOBUS_CURSOR_HOME` and no bound host, `promptobus status` on a task with a Cursor participant names the variable and `harnessStateHome` in the participant's line, instead of "there is nobody to ask about it".
- A harness whose driver declares no `inspect` still prints the original sentence — the reasonless case is unchanged.
- A driver error that is not a `GateError` still yields today's bare `unknown`, and one failing participant still does not stop the walk over the others.
- `npm test` stays green.

## Triage — 2026-09-07

- **Track:** D — Harness registries and Cursor / Claude drivers, extended to the shared snapshot seam it depends on (`src/driver.ts`, `lib/status.js`).
- **Priority:** P1. It is what PB-45 set out to deliver and did not reach: on the path an operator uses, a missing registry home is still silent.
- **Evidence level:** source review at `b798074` during PB-45's acceptance, including `src/driver.ts:723-737` and the `unknown` branch at `lib/status.js:250` that fires before any stall branch.
- **Next step:** implement as written, within the recorded constraint that one participant must not take down the snapshot. Whether `done` and the warden beat need their own wording is a separate question.
