# PB-261 · Minor batch: the no-identity unread tail, and the Cursor binary search inside the suite seal

- **Scope:** `lib/store.js` (`unreadNote`), `test/promptobus-driver-cursor.test.mjs`, [03-cli § The owner gate](../../reference/03-cli.md#ownership--the-owner-gate-of-done-stop-and-dismiss), [05-drivers § Cursor: tmux by absolute path](../../reference/05-drivers.md#cursor-tmux-by-absolute-path)
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** minor
- **Previous order:** 320
- **Taken:** 2026-09-26

## Context

Two minor entries left by tonight's pieces: a line that still tells a call with no session identity to fetch a mailbox it can only copy, and two suite checks that hand the Cursor binary search an environment without the suite's install-directory seal.

## Work to do

- [PB-178.4](../minor/PB-178.4-no-identity-unread-tail-says-fetch.md) — `unreadNote` (`lib/store.js:1363`) returns the own-mailbox "fetch it" line whenever `gated` is false, and a no-identity call is `gated: false`. For a no-identity call on the orchestrator address the tail names the unread count and says the call reads a copy, with the same route the mailbox reply gives.
- [PB-239.4](../minor/PB-239.4-suite-seal-misses-cursor-install-dirs.md) — the PB-93 checks call `findCursorBin` and `liveBin` with an environment that lacks `PROMPTOBUS_CURSOR_INSTALL_DIRS` (`test/promptobus-driver-cursor.test.mjs:341`, `:359`), so the default install list, which reaches `/usr/local/bin/cursor`, applies. They carry the seal, and a check shows every directory the search walks lies inside the run.

## Out of scope

- The mailbox copy itself and the contact point — PB-178.2 and PB-178.3.
- `readTmuxSessions` and its exit codes (PB-239.5).

## Verification

- Each entry's own evidence re-checked on the tree, closed with `archive N.k --into 261` and one outcome line per entry in this card's `result.md`; gates green.
