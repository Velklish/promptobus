# PB-208 · Accepting one piece cleans up nothing, and prune refuses on an active task

- **Order:** 50
- **Scope:** `lib/done.js` (`sweepWorktrees`, `sweepParticipantSecrets`), `lib/prune.js`, `lib/dismiss.js`, `lib/stop.js`, `lib/driver-codex.js` (participant homes), `docs/reference/03-cli.md`, `docs/reference/04-protocol.md` § Store layout
- **Created:** 2026-09-12, owner's decision of the same day
- **Dependencies:** PB-206

## Context

Everything the mechanism cleans up, it cleans up for a whole task. `done` stops the managed sessions, sweeps the worktrees of closed tasks, removes a branch it has proven merged by two measurements ([PB-6](../../archive/PB-6-done-blames-conflict-after-squash/result.md), [PB-158](../../archive/PB-158-done-keeps-a-branch-it-proved-merged/result.md)), and finally sweeps journals older than the threshold. Per piece there is nothing: `dismiss` removes supervision only, `stop` kills one session, and neither touches a directory. `engine.prune` **refuses on an active task** — and at the moment one piece is accepted, the task is still active by definition.

What that leaves behind, checked on disk rather than inferred:

- `artifacts/`, `blobs/` and `files/` of the accepted piece stay until the whole journal is swept;
- `workers/<stem>.settings.json` is removed by nobody — the secrets sweep takes the wake files, the MCP config and the `<stem>.*` directories, and the settings file is not in the list; a task closed on 2026-09-10 still carries three reviewer settings files and four turn sidecars;
- temporary participant homes are swept per participant at `done` and orphans at lift and at `stop`, but not at `done`; 17 mechanism directories were standing in the temporary root at the time of the measurement.

> Source: 2026-09-12, reading of `lib/done.js`, `lib/prune.js`, `lib/driver-codex.js` and of a closed task directory; counts reproduced by `ls` over the temporary root and the task's `workers/`.

The owner's decision of 2026-09-12 sets the boundary: **the telemetry a strategy is built from must survive**; the worktree and the branch of the accepted participant, the blobs and files of that piece, and the temporary stands may go. Sessions are already stopped by `done` and are not part of this card.

That boundary is not where the code draws it today. `telemetry.jsonl` lives outside the journal and survives anything. But `health.json`, `supervisor.log`, `stalls.json`, `messages/` and the wait sidecars — the only sources of delivery and idle time — are removed with the task directory and are projected nowhere (PB-205).

## Work to do

- Define the verb that accepts one piece and cleans up after it. The precedent for its shape is [ADR-012](../../adr/adr-012-stopping-one-participant-is-a-verb-of-its-own.md): an action over one participant is a verb, not a flag on `done`.
- List explicitly what it removes and what it must keep, and make the keep-list a check rather than a comment.
- Decide who calls it — the approver of PB-206 — and what happens when the piece is accepted but its branch is not provably merged: keep the tree, as `done` already does for that case.
- Close the settings-file gap while the file is open, or state why it stays.

## Out of scope

- The acceptance decision itself and who makes it — PB-206.
- Journal retention: the threshold is the consumer's decision and stands.
- Killing sessions: already done by `done`, and the owner did not ask to move it.

## Checks

- After accepting one piece: its worktree is gone, its branch is gone when provably merged, the blobs and files of that piece are gone — each verified by a command with its exit code, not by a printed summary.
- The task is still active afterwards and the other participants are untouched: their worktrees, sidecars and mailboxes unchanged.
- The keep-list holds: telemetry, messages and the health sidecars of the run survive the new verb, checked by file existence and by line count.
- A piece whose branch is not provably merged keeps its tree, and the verb says so instead of removing it silently.
