# PB-264 · Minor batch: a tmux list-sessions failure other than no server is not an empty server

- **Scope:** `lib/cursor-persist.js` (`readTmuxSessions`), [05-drivers § Cursor: tmux by absolute path](../../reference/05-drivers.md#cursor-tmux-by-absolute-path)
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** minor
- **Previous order:** 320
- **Taken:** 2026-09-26

## Context

`readTmuxSessions` reads every non-zero exit of `tmux list-sessions` as an empty server. That is right for a server that is not there, and a refusal path already exists for a tmux that could not be run at all (`sessions: null` with `missing`, which `findSession` turns into a refusal). A non-zero exit for any other reason falls between the two and reads a live participant as gone.

## Work to do

- [PB-239.5](../minor/PB-239.5-tmux-nonzero-list-reads-empty-server.md) — only the two no-server wordings measured on tmux 3.6b ("no server running on …", "error connecting to … (No such file or directory)") read as an empty server; any other non-zero exit takes the existing refusal path, naming tmux's own words, so a live participant is never read as gone on an unreadable server.

## Out of scope

- The lift's own list (`tmuxSessions`), where a tmux that cannot be read fails its `new-session` with the reason.
- Which other wordings tmux prints and when: not measured, and not needed — everything that is not a measured no-server line is refused.

## Verification

- A stub tmux that exits non-zero with each measured no-server line reads as an empty server; one that exits non-zero with any other line makes `findSession` refuse and names that line — each held by a test.
- The entry is closed with `archive 239.5 --into 264` and one outcome line in this card's `result.md`; gates green.
