# PB-35 · Result

**Outcome:** completed.

**What was done.** The reviewer's brief names the diff file a snapshot taken at a moment against a base, from the worktree HEAD, and says the working copy is the current state (a reviewer cannot run `git diff`: Bash is in `REVIEWER_DENY`, so the instruction is a read, not a command); a re-review re-snapshots, and there is no `--fresh`. The `review` command prints the snapshot pair beside the diff base line in both the real run and `--dry-run`. The participant record carries `metadata.diffAt` and `metadata.diffHead`, written at lift and patched on re-review by `stampSnapshot` (lib/store.js) under the task lock; `promptobus status` and `promptobus_task` print them, absent on records from older lifts. Reference (03-cli § Review), `skills/solo-review`, CHANGELOG updated.

**Verification.** Worker: `npm test` 47/47 files, `backslop lint` clean, mutation probe — the snapshot sentence removed from `subject()` reddens the prompt check. Isolated review (`reviewer:review`, `claude-fable-high` under `balance`): no critical or major findings, one minor (`--dry-run` printed the base without the snapshot pair while the reference promised the pair) — closed in 0b3f005 with a second check that runs the same regex on the dry-run path; closure verified by the approver on the diff. Approver, on the squashed main tree: `backslop lint` clean, `npm run audit` clean (411 tracked files and the tarball), `npm test` exit 0.

**Rejected alternatives.** `--fresh` on the reviewer's side (a bus round-trip ending in the command that already exists); the literal `git diff <base>` wording in the prompt (a denied command would burn a reviewer turn).

**Findings.** PB-35.1 — `npm run audit` red at HEAD on a backlog file naming the consumer CLI; fixed in main by the orchestrator (cae28d1) and closed with this task.
