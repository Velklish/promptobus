# PB-7 · Result

**Closed 2026-09-05.** Completed. The Cursor stall verdict had two signals — transcript growth and tool processes under the pane — both blind to an agent that edits files itself inside one long call. Third signal in `lib/cursor-persist.js`: `worktreeTouchedMs`, the newest mtime among `git ls-files -mo --exclude-standard` in the participant's own worktree plus its HEAD commit time; positive only (a recent write lifts a stall verdict, no write raises none, so a dead session still stalls), asked only when the first two already point at a stall. The verdict names each measurement and its span; the watchdog route says which signals answered and that the worktree may have been unreadable (a reviewer's sandbox has no commits). No live `cursor-agent` session was needed: the stand reproduces the shape deterministically (`HANG_WRITE`). Track `cli`, same worker and review round.

**Verification.** `promptobus-driver-cursor.test.mjs` 109/109 (was 104). Probes, commit-first: the signal forced to "nothing written" → the two editing-participant checks red; forced to "just written" → the three dead-session checks red; the old route wording restored → red. Gates re-run on the merged `main` tree by the approver.

**Documentation in the same pass.** `docs/reference/03-cli.md` (the three-signals paragraph beside the `status` verdict), `CHANGELOG.md`.
