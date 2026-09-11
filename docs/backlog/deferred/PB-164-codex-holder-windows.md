# PB-164 · Codex holder on Windows: the app-server holder is unmeasured there

- **Scope:** `lib/codex-session.js` (the holder process, registry, wake channel, paths), `lib/driver-codex.js`, [03-cli](../../reference/03-cli.md) § The Codex holder, `test/promptobus-driver-codex.test.mjs`
- **Created:** 2026-09-11
- **Dependencies:** PB-161

## Context

Owner decision of 2026-09-11 (harness-parity run): Windows is in scope for Codex participants. The holder — `codex app-server --stdio`, the thread registry, the wake channel, the isolated home of PB-161 — is measured on macOS only; path separators, `realpath` for the trust record, signals used to stop the holder, socket or pipe paths, `$TMPDIR` and home resolution on Windows are unmeasured. No Windows stand on the mechanism side: the live run is the owner's.

## Work to do

- Audit the holder and the driver for POSIX assumptions (signals, sockets, path joins, `realpath`, temp and home directories) and fix what a faked `win32` platform reveals; name what only a live run can show.
- Docs: a Windows paragraph in 03-cli § The Codex holder; CHANGELOG.
- Tests with the platform faked to `win32`; an explicit line that the live run is pending and by whom.

## Out of scope

- Cursor on Windows — PB-163.
- The isolated home itself — PB-161.

## Verification

- Tests above green with the faked platform; the live Windows run reported by the owner (command, exit code, output) before the card closes.
- `npm test`, `npx github:Velklish/backslop#v0.4.0 lint`, `npm run audit` green.

## Deferred

- **Deferred:** 2026-09-12
- **Reason:** the owner deferred the whole Windows line on 2026-09-12. The app-server holder has never been observed on Windows, and the question is about process lifetime and signals, which reading the code cannot answer.
- **Return condition:** same as PB-163 — a Windows stand, or an explicit decision that Windows is out of scope, recorded as a boundary.
