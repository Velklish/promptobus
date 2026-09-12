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

Four exact synthetic fixtures are exempt, each for the input it deliberately carries:

- test/model-routing-adapter-claude.test.mjs — synthetic home passed to credentialFile;
- test/model-routing-preflight.test.mjs — synthetic path in a driver error fixture;
- test/runner.test.mjs — synthetic executable path in the trace fixture;
- test/session-env.test.mjs — synthetic parent HOME values for environment filtering.

There is no directory-wide test exemption. The rule names these four files and no other fixture.

The repository rule assigns the work across roles: the participant owns the rule and its
documentation, while the approver owns archived records and card movement. The approver cleaned the
six historical archive records in commit 53f227b. The participant took that approver commit into
this branch as 6509463 for the full-tree audit; no archive file was edited by the participant.

Before the live queue sweep, npm run audit exited 1 and printed exactly these two findings:

    absolute owner home path: docs/backlog/queue/PB-118-done-triple-listtasks-walk.md
    absolute owner home path: docs/backlog/queue/PB-127-dead-file-citations-in-comments.md

After the approver's archive cleanup and the live-card normalization, npm run audit exited 0
with the rule active across tracked text and packed-tarball text. The first all-text pass found the
four synthetic inputs listed above; exact file exemptions preserve those intentional fixtures without
excluding a directory or a surface.

## Work to do

- Keep the absolute owner-home rule in scripts/audit-public.mjs assembled from fragments so the
  rule does not exempt itself.
- Keep the rule active for all tracked text and packed-tarball text, with only the four named fixture
  exemptions and their stated reasons.
- Keep the two live cards and the six archive records workspace-relative, preserving measured
  meaning without the owner's login or private repository root; the approver owns the archive edits.
- Keep the reference README and CHANGELOG in the same pass.
- Prove the pure verdict for a bare owner-home form, the negative nested-directory case, and the
  exact fixture exemptions.
- Keep both mutation proofs: the archive path probe must name a restored archive file, and removing
  the optional child-path tail must make the bare-form verdict fail before the snapshot restores it.

## Out of scope

- The brand exemption itself for evidence cards. It is a separate decision with its own reasons.
- Anything about the private consumer repository beyond removing its path from this tree.
- Archiving or moving this card; acceptance and triage belong to the approver.

## Verification

- Before the live sweep, npm run audit exited 1 with exactly two findings, one for each live queue
  card named above.
- npm run audit after the approver cleanup and rule change exited 0: the tarball had 126
  entries and the audit read 855 tracked files with a clean verdict.
- npm run probe -- docs/archive/PB-112-reference-docs-lag-current-code/task.md --stdin-patch --run "npm run audit"
  exited 0 overall; the mutated audit exited 1 with one absolute owner home path verdict naming
  that archive file, and the restored audit exited 0 with zero verdicts.
- node test/promptobus-package.test.mjs exits 0 with 43/43 verdicts; it covers the bare form,
  the four exact fixture exemptions and the nested-directory negative case.
- A mutation probe against scripts/audit-public.mjs runs that package test: the outer probe exits
  0, the mutated package test exits 1 on publicity audit rejects a bare owner-home fixture, and
  the restored package test exits 0 with 43/43.
- A final diff scan must find no absolute owner-home path in changed participant-owned files and no
  foreign tracker or memory-service identifiers. The approver-owned archive diff is recorded
  separately by commit 53f227b.
- This card remains in the queue for approver acceptance; it is not archived here.
