# PB-99 · `inspect` calls a Codex participant alive and rising for as long as the record sits at `state: starting` with no thread id, an error on the record and an hour-old `startedAt` change nothing, so a lift killed mid-preamble leaves a dead participant shown as working with no stall route

- **Scope:** `lib/driver-codex.js` (`inspect`), `lib/codex-session.js` (`waitReady`, `readyMs`), `lib/status.js`, `src/supervisor.ts`, [reference/03-cli.md](../../reference/03-cli.md) section The Codex holder
- **Created:** 2026-09-06
- **Dependencies:** PB-49
- **Taken:** 2026-09-08

## Context

`lib/driver-codex.js:310-318` branches only on `!id && record.state === 'starting'`, inside the `!holderAlive(ref)` guard:

```js
if (!holderAlive(ref)) {
  if (!id && record.state === 'starting') {
    return {
      state: 'alive', busy: true, stall: null, id: null,
      note: 'rising - the thread is not named yet',
    };
  }
```

Neither `record.error` nor `record.startedAt` is read. Verified now on this tree (sandboxed PROMPTOBUS_CODEX_HOME): three `starting` records with a dead `holderPid` and an hour-old `startedAt` - one carrying `error: 'thread is already held by process 4242'`, one with no error, one with `holderPid: null` - all three return `{state:'alive', busy:true, stall:null, note:'rising - the thread is not named yet'}`.

Both failure paths this branch could plausibly be covering are already caught while the lift command is still alive: `waitReady` (`lib/codex-session.js:362-368`) returns on the first 50 ms poll that sees `rec.error`, and `lib/driver-codex.js:427-433` then calls `dropSession`, so `inspect` answers `gone` with a route in that case. What survives is a lift command that never reaches `waitReady`'s return at all: the participant is written to the bus journal before the driver lift runs (`lib/spawn.js:1268`, `openParticipant`), the Codex record is written at `lib/driver-codex.js:387-421`, and the default lift budget is `readyMs()` = `preambleMs()` (30000+3000+15000+60000+10000 = 118000 ms) + `TURN_STARTED_TIMEOUT_MS` (15000 ms) = 133000 ms, i.e. 133 s (`lib/codex-session.js:188-196`). An orchestrator running `promptobus spawn --harness codex` from a 120 s Bash-tool timeout is killed 13 s inside its own budget, leaving a bus participant plus a `starting` Codex record with a dead holder.

The readers then say nothing is wrong: `lib/status.js:265` prints `session "..." is alive (rising - the thread is not named yet)`, and the supervisor's walk (`src/supervisor.ts:300-360`) files no `gone`, no `stale`, and no stall (`view.stall` stays `null`), so no relift route reaches a human. Nothing sweeps a stale `starting` record.

The existing 30 s `justSpawned` grace (`src/supervisor.ts:55`, `SPAWN_GRACE_SEC`) already covers a genuinely-rising participant at the bus level, and it is shorter than the 133 s Codex preamble - which is exactly what this driver branch is compensating for. The bound belongs on the record's own `startedAt` + `readyMs`, not on a bare cutoff copied from elsewhere.

## Work to do

- In the `!holderAlive(ref)` branch of `inspect` (`lib/driver-codex.js:310-318`): an error on the record with no live holder is never rising - return `state: 'stale'` with `stall.reason = record.error`, so the holder-lock refusal reaches `status` in the words the holder wrote.
- Bound the rising window by the record's own budget: past `record.startedAt + readyMs(env)`, a nameless thread with a dead holder is `stale` (the holder did not name a thread within N ms, the lift did not finish), not rising. Inside the window the branch answers exactly as it does today.
- If docs/reference/03-cli.md section The Codex holder documents the rising note's meaning, update it to describe the bounded window.

## Out of scope

- Any change to the two paths that already resolve correctly today (waitReady's error return, the dead app-server branch) - this entry touches only the no-holder-yet branch.
- Folding this into PB-42's activity watchdog: that series reads app-server events over a RUNNING turn, which do not exist when the holder dies before thread/start emits anything. It is a natural sibling of that series, not a duplicate - worth the owner's judgment on whether to fold in, not decided here.

## Verification

- Adapter-level test: a record at `state: 'starting'` with a dead `holderPid` and (a) an `error` field, (b) a `startedAt` older than `readyMs` - `inspect` answers `stale` in both cases and `status` prints a LISTED line with a relift route. A record still inside the window answers `rising` as before.
- `npm test`.

## Triage — 2026-09-07

- **Track:** C — Codex session lifecycle.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/driver-codex.js:310`, `lib/codex-session.js:362`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
