# PB-333 · Cleanup has two verbs: sweep removes a piece's worktree and branch only, done applies the retention, and prune goes

- **Scope:** [03. CLI § Status, done, sweep, dismiss, history, prune](../../reference/03-cli.md#status-done-sweep-dismiss-history-prune)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major

## Context

Three commands remove stored state today.

- **`sweep <address>`.** It runs after one accepted piece, mid-run. It removes the participant's worktree and branch, and also the metadata records, `files/` entries and blobs of the artifacts the participant sent: its gate and handover records and its evidence. The same section keeps the piece's brief and review diff as "evidence, not product". In run bs020 on 2026-10-03 the orchestrator copied `files/` to a scratch directory before every sweep to keep the gate records the acceptance cited.
- **`done`.** It ends a run. On the same call it removes the journals of tasks closed more than `PRUNE_DEFAULT_DAYS` (14) days ago.
- **`prune`.** It does that removal by hand, previews by default, and takes another age.

Journals grow only while runs go, and every run ends with `done`, so the retention already applies without `prune`. Source: 2026-10-04, `promptobus prune` → "nothing to remove: no closed tasks older than 14 d (younger — 26)"; the store holds 28 tasks and 185 MB.

Owner decision on 2026-10-04: two verbs by lifecycle.
- `sweep` cleans up a piece, `done` closes a run and applies the retention.
- `prune` goes; early removal is a flag on `done`.
- One retention rule covers everything: the task journal, its attachments and the participant mailboxes of PB-331 leave 14 days after the close. Telemetry stays.

## Work to do

- `sweep` removes the worktree and the branch only. Artifact records, `files/` entries and blobs stay with the task journal.
- Remove `prune`. Add a flag on `done` that applies the retention with a shorter age, with the preview `prune` gives today.
- Update 03-cli, the orchestrate skill and the CHANGELOG.

## Out of scope

- The 14-day default.
- Consumers that call `prune`: they follow at their repin.

## Verification

- After `sweep`, the participant's gate and handover records are still in `files/`; a test fails on the old `sweep`.
- `prune` is gone from the help, and the `done` flag removes a journal older than the given age after a preview; tests fail on the old CLI.
