# PB-311 · Accept backslop's hook records in a project's Codex and Cursor hook files instead of refusing or overwriting them

- **Scope:** [05. Drivers](../../reference/05-drivers.md)
- **Created:** 2026-09-30
- **Dependencies:** none
- **Previous order:** 172
- **Taken:** 2026-10-03

## Context

On 2026-09-30 the owner decided that backslop ships agent hooks as a project's choice. A project that sets `hooks` in `backslop.json` gets owned records in its project hook files: `.claude/settings.json`, `.cursor/hooks.json` and `.codex/hooks.json`. Each record runs `<cli> hook session-start|stop --harness <id>`. The stop hook returns the agent's turn when `lint` reports an error in a file the session changed. The backslop cards are BS-194…BS-196 in github.com/Velklish/backslop, planned for its v0.14.0.

Such a file is committed in the project, so it is present in every worktree promptobus lifts a participant in. Two drivers collide with it at this repository's `v0.21.0`:

- **Codex refuses the lift.** `refuseForeignProjectLayer` (`lib/driver-codex.js`) throws when a `hooks.json` exists at the discovery path and is not the file the lift writes. For a linked worktree, the discovery path is the main checkout's `.codex/hooks.json` (`projectHooksDir`). The refusal says: "Codex would run <file> with hook trust bypassed, and that file is not the hooks file this lift writes." A project that selects backslop's Codex hooks can then run no Codex participant.
- **Cursor overwrites the file.** `prepare` (`lib/driver-cursor.js`) writes `.cursor/hooks.json` into the participant's working directory (`configDir = cwd` for a worker and an approver) with the guard record only. When the file is tracked, the worker's tree shows a modified tracked file, and backslop's records do not run in that session. The `.cursor/.gitignore` the lift writes (`*`) does not hide a tracked file.
- **Claude Code** participants get the guard through their own `--settings` file, and project settings still load. No collision is expected; this is not measured.

The Codex refusal exists for a reason: `--dangerously-bypass-hook-trust` trusts every project hooks file loaded from an enabled layer (`docs/guides/hooks-and-trust.md`, "What the trust bypass trusts"). Accepting a foreign file therefore means running its commands without the owner's review.

## Work to do

- Decide, as an ADR of this repository, which foreign records a participant lift accepts. The narrowest rule that works: records whose command is `<cli> hook session-start|stop --harness <id>`, where `<cli>` is the `cli` field of the `backslop.json` at the clone root. Any other foreign record keeps today's refusal.
- **Codex:** when the discovered file holds only accepted records, merge them into the hooks document the lift writes and lift the participant; otherwise refuse as today, and name the records that caused it.
- **Cursor:** write the lift's `.cursor/hooks.json` as a merge. Keep the accepted records of a tracked file, and leave the tracked file's bytes unchanged when they already hold the guard record. Otherwise write the merged file where it does not dirty a tracked path. Measure on a live Cursor participant which of the two Cursor reads, and record that.
- Tests for both drivers: an accepted file lifts, and a file with a foreign non-backslop record still refuses (Codex) or is kept out (Cursor). A tracked `.cursor/hooks.json` leaves `git status --porcelain` of the worker's tree empty.
- `docs/guides/hooks-and-trust.md` and `docs/reference/05-drivers.md`: the accepted-record rule and why.

## Out of scope

- Writing backslop's records into any file: backslop's `init` owns them.
- Accepting arbitrary foreign hooks.

## Verification

- A clone whose main checkout has a `.codex/hooks.json` with only a backslop record: a Codex worker lifts, and its first `Stop` runs both the guard and the backslop record (holder journal, `hook/started stop` lines).
- A clone with a tracked `.cursor/hooks.json` holding a backslop record: a Cursor worker lifts, and `git -C <worktree> status --porcelain` is empty after the lift.
- `npm test` and the repository gates exit 0.
