# PB-151 · `injectText` writes the wake text into a world-readable `.buf` file and skips cleanup when the tmux load fails, so a message preview outlives its delivery

- **Scope:** `lib/cursor-persist.js` (`injectText`, `bufferFile`, `writeJson`, `dropSession`)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

lib/cursor-persist.js:555 `writeFileSync(buf, text)` writes the rendered wake notification with no `mode` option, so it lands at the default umask (world-readable, typically `0644`) in `sessionsDir()` — the same directory as the session record. `text` embeds real message content: driver-cursor.js:660 builds it with `previewBlock(msgs, KNOCK_TEXT_MAX)`, up to `KNOCK_TEXT_MAX` (2000, `lib/contract.js`) characters of actual bus traffic. Right next to it, `writeSession` (cursor-persist.js:265-268) is explicitly `{ secret: true }` (mode `0600`), with the comment: 'the record holds a working-tree path, a chat id, and a session name — not a token, but not something the whole machine should read either.' The file that carries the message content itself gets no such treatment.

Cleanup is also incomplete on one path. If the `tmux load-buffer` call fails, `injectText` returns at cursor-persist.js:558-559 before reaching the `rmSync(buf, { force: true })` at line 565 — that removal sits inline after the `paste-buffer` attempt, not in the `finally` block, which at lines 591-593 only drops the inject lock (`rmSync(lock, { force: true })`). So the buffer file is only guaranteed gone when the whole session is torn down: `dropSession` (lines 285-289) unlinks `bufferFile(ref, env)` alongside the record, launch script and lock. On a `load-buffer` failure, the last wake text — an actual message excerpt — sits world-readable on disk until the participant is dropped, which can be the rest of the task.

## Work to do

- Pass `{ mode: 0o600 }` to the `writeFileSync(buf, text)` call at cursor-persist.js:555, matching the `secret` flag `writeJson` already applies to the session record.
- Move `rmSync(buf, { force: true })` out of its inline spot at line 565 and into the `finally` block (lines 591-593), next to the lock drop, so it runs on every exit path of `injectText` — including the `load-buffer`-failure return at line 558-559.
- Add a case to the Cursor persist test suite that forces `tmux load-buffer` to fail and asserts the `.buf` file is gone right after `injectText` returns (not only after `dropSession`), plus a case asserting the file's mode is `0o600` on a normal delivery.

## Out of scope

- Hardening `sessionsDir()` itself or any other file it holds — this is one write inside `injectText`, not a directory-wide permissions pass.
- Changing what `text` carries or how much of a message it previews (`KNOCK_TEXT_MAX`) — the fix is about who can read the file, not what goes into it.

## Verification

- Checking the file mode of the `.buf` file immediately after a delivery shows `0600`.
- A test that makes `tmux load-buffer` return non-zero shows the `.buf` file removed right after `injectText` returns, not only after `dropSession`.
