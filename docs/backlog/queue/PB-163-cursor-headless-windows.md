# PB-163 · Cursor participant on Windows: headless turns without tmux, OS-aware dependency install

- **Order:** 38
- **Scope:** `lib/driver-cursor.js`, `lib/cursor-persist.js`, [03-cli](../../reference/03-cli.md) § Cursor participant, `test/promptobus-driver-cursor.test.mjs`
- **Created:** 2026-09-11
- **Dependencies:** none

## Context

Owner decision of 2026-09-11 (harness-parity run): Windows is in scope for both Cursor and Codex participants. The consumer's card ati-agents BL-507 states the shape: the persist session through `tmux` stays a Unix path; on Windows the participant must run headless turns (`agent -p --resume`), and `tmux` must be neither probed, nor required, nor installed there. The differences of the two paths — a live process, delivery of a message during a turn (only between turns without persist), `attach` — must be named in the docs rather than discovered. Nobody on the mechanism side has a Windows stand: the live run is the owner's, code goes by the docs and by tests with a faked platform.

## Work to do

- A Windows path in the Cursor driver: headless turns without `tmux`; the dependency probe reports `tmux` only on Unix; the driver's capabilities and `skillsNote`/delivery notes say which path is active.
- Docs: the two paths side by side in 03-cli; CHANGELOG.
- Tests with `process.platform` faked to `win32`: no `tmux` lookup, headless argv, delivery-between-turns semantics; an explicit line that the live Windows run is pending and by whom.

## Out of scope

- OS-aware installation of dependencies in the consumer's `setup` — the consumer's card.
- Codex on Windows — PB-164.

## Verification

- Tests above green on macOS with the faked platform; the live Windows run reported by the owner (command, exit code, output) before the card closes.
- `npm test`, `npx github:Velklish/backslop#v0.4.0 lint`, `npm run audit` green.
