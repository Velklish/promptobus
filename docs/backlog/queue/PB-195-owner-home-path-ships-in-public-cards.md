# PB-195 · Evidence cards ship the owner's absolute home path to a public repository, and the publicity audit has no rule for it

- **Order:** 15
- **Scope:** `scripts/audit-public.mjs`, [reference/README](../../reference/README.md)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

A source review found eight tracked documentation files carrying an absolute owner-home path:
six historical records under docs/archive/ and two live records under docs/backlog/queue/.
The six historical files are PB-144, PB-166.2, PB-119, PB-63, PB-112 and PB-56. PB-89
contains only an ellipsis placeholder and is not one of the eight path-shaped records.

The baseline publicity audit was green before this task: npm run audit exited 0 on the tree with
853 tracked files and a 126-entry tarball. The audit had no rule for this path form. The brand
rule's evidence-card exception was not a decision about owner paths.

## Scope decision and measurements

The rule detects the POSIX owner-home shape at a text boundary, assembled from fragments rather
than one login. It runs on every tracked text file and every text entry in the packed tarball. The
user segment may have no child path or may have one; a bare root-plus-user form is a finding, while
a home-named segment nested below another directory is not.

Four named fixtures contain five synthetic home literals. The audit removes only those exact
literals before matching, with the reason kept beside each fixture:

- test/model-routing-adapter-claude.test.mjs — the synthetic home passed to credentialFile;
- test/model-routing-preflight.test.mjs — the synthetic path in a driver error fixture;
- test/runner.test.mjs — the synthetic executable path in the trace fixture;
- test/session-env.test.mjs — the two synthetic parent HOME values for environment filtering.

No file is exempt. A different owner-home path in any named fixture remains a finding, and path
boundaries prevent a longer or nested path from being mistaken for one of the literals.

The repository rule assigns the work across roles: the participant owns the rule and its
documentation, while the approver owns archived records and card movement. The approver cleaned the
six historical archive records in commit 53f227b. The participant took that approver commit into
this branch as 6509463 for the full-tree audit; no archive file was edited by the participant.

Before the live queue sweep, npm run audit exited 1 and printed exactly these two findings:

    absolute owner home path: docs/backlog/queue/PB-118-done-triple-listtasks-walk.md
    absolute owner home path: docs/backlog/queue/PB-127-dead-file-citations-in-comments.md

After the approver's archive cleanup and the live-card normalization, npm run audit exited 0
with the rule active across tracked text and packed-tarball text. The first all-text pass found the
five synthetic literals in four fixtures; exact literal removal preserves those intentional inputs
without excluding a file, directory or surface.

## Work to do

- Keep the absolute owner-home rule in scripts/audit-public.mjs assembled from fragments so the
  rule does not exempt itself.
- Keep the rule active for all tracked text and packed-tarball text, removing only the five named
  synthetic literals from the four fixtures and preserving findings for any other path.
- Keep the two live cards and the six archive records workspace-relative, preserving measured
  meaning without the owner's login or private repository root; the approver owns the archive edits.
- Keep the reference README and CHANGELOG in the same pass.
- Prove the pure verdict for a bare owner-home form, the negative nested-directory case, the
  five exact literals, a different path in each named fixture, and text detection by contents.
- Keep the archive probe and add one mutation for a different path in a named fixture and one for
  an owner-home path in a text surface outside the former extension allowlist.

## Out of scope

- The brand exemption itself for evidence cards. It is a separate decision with its own reasons.
- Anything about the private consumer repository beyond removing its path from this tree.
- Archiving or moving this card; acceptance and triage belong to the approver.

## Verification

- Before the live sweep, npm run audit exited 1 with exactly two findings, one for each live queue
  card named above.
- npm run audit after the approver cleanup and rule change exited 0: the tarball had 126
  entries; the audit checked 855 tracked text files and 126 packed text entries with a clean verdict.
- npm run probe -- docs/archive/PB-112-reference-docs-lag-current-code/task.md --stdin-patch --run "npm run audit"
  exited 0 overall; the mutated audit exited 1 with one absolute owner home path verdict naming
  that archive file, and the restored audit exited 0 with zero verdicts.
- node test/promptobus-package.test.mjs exits 0 with 45/45 verdicts; it covers the bare form,
  all five exact fixture literals, a different path in every named fixture, the extensionless
  text surface and the nested-directory negative case.
- npm run probe -- scripts/audit-public.mjs --stdin-patch --run "node test/promptobus-package.test.mjs" < /private/tmp/pb195-fixture-boundary.patch
  exited 0 overall; the mutation exited 1 on publicity audit does not exempt a whole synthetic
  fixture file, and snapshot restore exited 0 with 45/45.
- The same command with /private/tmp/pb195-content-surface.patch exited 0 overall; the mutation
  exited 1 on publicity audit recognizes extensionless text by contents, and snapshot restore
  exited 0 with 45/45.
- A final diff scan must find no absolute owner-home path in changed participant-owned files and no
  foreign tracker or memory-service identifiers. The approver-owned archive diff is recorded
  separately by commit 53f227b.
- This card remains in the queue for approver acceptance; it is not archived here.
