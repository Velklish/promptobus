# PB-252 · The restart advice for a Codex participant says to close the whole task, while stop takes one thread

- **Order:** 65
- **Scope:** [05-drivers](../../reference/05-drivers.md), [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-24
- **Dependencies:** none
- **Cost:** major

## Context

Found on 2026-09-24 while a consumer's orchestration skill was being checked against this package's code: the skill said a Codex participant cannot be stopped on its own, and the package's own phrase says the same, while the package's `stop` does exactly that.

The phrase: `lib/driver-codex.js:85-86`, `PHRASES.stop` — "stop the thread through the mechanism (<done command> / another spawn after stop) — Codex has no single-thread kill command, the app-server process holds the session". `lib/spawn.js:764` puts it into the refusal a repeat spawn prints for a live address: "If you need a restart — close the session first: " followed by `driver.phrases.stop('<id>', host.busCommand(['done']))`. For a Codex participant the printed route to restart one participant is therefore `done`, which closes the whole task and stops every managed session in it.

The package can stop one Codex participant: `promptobus stop <address>` goes through the driver's `stop` — `lib/driver-codex.js:861`, `async function stop(ref)`, stops the holder of that one thread — and the driver declares `stop: true` among its capabilities (`lib/driver-codex.js:908`).

Checked on `a7b842f1` (tag `v0.16.0`): `grep -n "single-thread" lib/driver-codex.js` → line 86; `sed -n '758,768p' lib/spawn.js` → the restart advice at line 764; `grep -n "stop:" lib/driver-codex.js` → lines 85 and 908.

**Cost major:** an operator who follows the printed advice to restart one Codex participant closes the task, and every other participant's session goes with it.

## Work to do

- Make the Codex route name the one-thread stop (`promptobus stop <address>`) instead of `done`: either the Codex `PHRASES.stop` or `lib/spawn.js:764` choosing the stop command when the driver declares the `stop` capability.
- Check the Claude and Cursor phrases printed by the same line for the same drift.
- A test on the refusal text for a live Codex address that is red while it names `done`.

## Out of scope

- The Codex holder model itself.

## Verification

- A repeat spawn at a live Codex address prints a restart route that stops only that participant, and the test above is red on `a7b842f1`.
