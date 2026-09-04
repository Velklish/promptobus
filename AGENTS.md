<!-- backslop:start -->
## Tasks and decisions — backslop

The task tracker and decision log live in `docs/` and are managed with `npx github:Velklish/backslop#v0.3.0` (configuration: `backslop.json`, task prefix: `PB`). There is no task list in files: `npx github:Velklish/backslop#v0.3.0 status` prints the queue, active work, deferred work, and triage. The operating rules are in `docs/backlog/README.md`; terms are in `docs/GLOSSARY.md`. The layout version is the `version` field in `backslop.json`; update backslop with `npx github:Velklish/backslop#v0.3.0 upgrade` when you decide to, not because of someone else's commit.

**Skills (when an adapter is selected):** `backslop-task` — the lifecycle of one task; `backslop-batch` — a worker run by tracks; `backslop-seed` — populate documentation after installation.

**Change procedure.** There are two roles: the worker implements and verifies (steps 1–4), the approver accepts and closes (5–7); a single agent performs both roles in order.

1. **Task.** Take the first queued task (`npx github:Velklish/backslop#v0.3.0 status`) or create one: `npx github:Velklish/backslop#v0.3.0 new <slug> --title "…"` puts it in triage; `--queue` puts it directly in the queue. A small change without a tracker record is allowed if one pass fully implements it and it does not change a contract. A finding this pass will not close becomes a file immediately: `npx github:Velklish/backslop#v0.3.0 new <slug> --parent N`, with evidence.
2. **Change.** Reverse a previous decision by clean removal, without strikethroughs or “cancelled” notes. Preserve the style of the existing file. Use terms from the glossary; if a required term is missing, propose it rather than silently inventing it.
3. **Documentation in the same pass.** An undocumented change is incomplete: update the relevant `docs/reference/` section, the affected subsystem README, and CHANGELOG. An architectural decision needs `npx github:Velklish/backslop#v0.3.0 adr <slug>` and a row in `docs/README.md`.
4. **Gates before reporting.** The commands in `gates` in `backslop.json` must be green. Verify a test change with a mutation probe: commit first, then run the probe.
5. **Acceptance and archive** are one approver pass: review the diff, run `npx github:Velklish/backslop#v0.3.0 archive N`, complete `result.md` (outcome, what was done, verification), and ensure `npx github:Velklish/backslop#v0.3.0 lint` is green. A worker does not declare their work accepted or move task files between directories.
6. **Triage review** follows closure immediately: every entry gets a next step — merge, clarify, `npx github:Velklish/backslop#v0.3.0 mv N queue`, or `npx github:Velklish/backslop#v0.3.0 mv N deferred` with a return condition. Ask the owner only before rejecting an entry.
7. **Commit.** Start the message with the task number: `PB-N: <what was done>`. A task reaches the main branch as one commit: taking it, review fixes, and acceptance are squashed before pushing.

Worker boundaries: change only the assigned branch or worktree; do not touch status directories or `docs/archive/`; closure and triage belong to the approver.
<!-- backslop:end -->
