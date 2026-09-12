# PB-195 · Evidence cards ship the owner's absolute home path to a public repository, and the publicity audit has no rule for it

- **Order:** 15
- **Scope:** `scripts/audit-public.mjs`, [reference/README](../../reference/README.md)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

A source review found eight tracked documentation files carrying an absolute owner-home path:
six historical records under `docs/archive/` and two live records under `docs/backlog/queue/`.
The six historical files are PB-144, PB-166.2, PB-119, PB-63, PB-112 and PB-56. PB-89
contains only an ellipsis placeholder and is not one of the eight path-shaped records.

The baseline publicity audit was green before this task: `npm run audit` exited 0 on the tree with
853 tracked files and a 126-entry tarball. The audit had no rule for this path form. The brand
rule's evidence-card exception was not a decision about owner paths.

## Scope decision and measurements

The rule detects the POSIX owner-home path shape by fragments, not one login. It applies to every
documentation record under `docs/`, including `docs/archive/`. The separate brand-word exemption
for historical evidence is unchanged; it is not an exemption for owner-home paths.

The repository rule assigns the work across roles: the participant owns the rule and its
documentation, while the approver owns archived records and card movement. The approver cleaned the
six historical archive records in commit 53f227b. The participant took that approver commit into
this branch as 6509463 for the full-tree audit; no archive file was edited by the participant.

Before the live queue sweep, `npm run audit` exited 1 and printed exactly these two findings:

    absolute owner home path: docs/backlog/queue/PB-118-done-triple-listtasks-walk.md
    absolute owner home path: docs/backlog/queue/PB-127-dead-file-citations-in-comments.md

After the approver's archive cleanup and the live-card normalization, `npm run audit` is expected
to exit 0 with the rule active across `docs/`. A first all-text version also found four synthetic
paths in test fixtures. That was a false positive for this subject, so the rule remains scoped to
`docs/` rather than all tracked text.

## Work to do

- Keep the absolute owner-home rule in `scripts/audit-public.mjs` assembled from fragments so the
  rule does not exempt itself.
- Keep the rule active for all `docs/`, including the archive; the approver's cleanup supplies the
  clean historical evidence.
- Keep the two live cards and the six archive records workspace-relative, preserving measured
  meaning without the owner's login or private repository root.
- Keep the reference README and CHANGELOG in the same pass.
- Prove the rule with the recorded red queue measurement and a green full-docs audit after cleanup.
- Run a new mutation probe against a cleaned `docs/archive/` file: temporarily restore an absolute
  path there, and require the audit to name that archive file before the snapshot restores it.

## Out of scope

- The brand exemption itself for evidence cards. It is a separate decision with its own reasons.
- Anything about the private consumer repository beyond removing its path from this tree.

## Verification

- Before the live sweep, `npm run audit` exited 1 with exactly two findings, one for each live queue
  card named above.
- `npm run audit` after the approver cleanup and rule change exited 0: the tarball had 126
  entries and the audit read 855 tracked files with a clean verdict.
- `npm run probe -- docs/archive/PB-112-reference-docs-lag-current-code/task.md --stdin-patch --run "npm run audit"`
  exited 0 overall; the mutated audit exited 1 with one `absolute owner home path` verdict naming
  that archive file, and the restored audit exited 0 with zero verdicts.
- A final diff scan must find no absolute owner-home path in changed participant-owned files and no
  foreign tracker or memory-service identifiers. The approver-owned archive diff is recorded
  separately by commit 53f227b.
- This card remains in the queue for approver acceptance; it is not archived here.
