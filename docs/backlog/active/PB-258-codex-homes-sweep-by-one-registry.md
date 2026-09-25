# PB-258 · A Codex lift sweeps the machine-wide participant homes root by its own registry — a scratch run or a standalone driver suite deletes the homes of live participants

- **Scope:** `lib/driver-codex.js` (`sweepParticipantHomes`), `test/promptobus-driver-codex.test.mjs`, `test/promptobus-spawn.test.mjs`, [05-drivers](../../reference/05-drivers.md) § sweepParticipantHomes
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 270
- **Taken:** 2026-09-26

## Context

Measured on 2026-09-25 during a backlog run, installed promptobus 0.17.0. `$TMPDIR/promptobus-codex-homes/` was emptied at about 22:40Z and again at about 22:42Z while three Codex participants of the run were alive. The two worker homes were gone; the reviewer's home, re-created by its app-server, held no `auth.json`. The three app-server processes kept running with `CODEX_HOME` pointing at the removed directories (`ps eww`).

The sweep is the cause. Every Codex lift calls `sweepParticipantHomes(env)` (`lib/driver-codex.js:778`), and `stop` of a ref without a record calls it too (`:889`). It removes every directory under the root that the registry of ITS environment does not name (`:255`, `live = new Set(registrySessions(env)…)`). The root is one per machine — `path.join(tmpdir(), 'promptobus-codex-homes')` — while the registry is one per `PROMPTOBUS_CODEX_HOME`. A lift under a second registry sees every live home of the first as an orphan.

Two kinds of lift did it that night, each under a registry other than the run's:

- a scratch run: `node bin/promptobus.js spawn … --harness codex` three times with `PROMPTOBUS_CODEX_HOME=<scratch>/codex-state` and the real `TMPDIR`;
- single suite files run outside `npm test`: `node test/promptobus-driver-codex.test.mjs` and `node test/promptobus-spawn.test.mjs`. The runner diverts `TMPDIR` for its own children only (`test/run.mjs`), so a file run on its own lifts test participants under sandbox registries against the real root.

The comment on the function guards one case — an undeclared registry home, where "every home here would look orphaned" — and not a declared, different one.

## Work to do

- The sweep must not remove a home that another registry names. One way: a home records the registry that made it, and a sweep removes only homes of its own registry. Another: one root per registry. The worker chooses and the reference names the choice.
- A single suite file that lifts Codex participants does not reach the real root when run on its own.
- 05-drivers § sweepParticipantHomes says what a sweep may remove and what it never removes.

## Out of scope

- The credentials copied into a home (PB-259).

## Verification

- A test with two registries and one live home each under one root: a lift under the second leaves the first one's home in place.
- A single-file run of the driver suite on a machine with a live participant leaves that participant's home in place.
