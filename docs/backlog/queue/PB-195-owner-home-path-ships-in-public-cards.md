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

The new rule detects the POSIX owner-home path shape by fragments, not one login. It applies to
documentation under docs/ and includes live queue records. It explicitly excludes docs/archive/
because the repository rules make the archive immutable; those six historical files are scanned
and named here but are not rewritten. This is a narrower, explicit archive exception, not reuse
of the broader brand exception.

Before the live queue sweep, npm run audit exited 1 and printed exactly these two findings:

    absolute owner home path: docs/backlog/queue/PB-118-done-triple-listtasks-walk.md
    absolute owner home path: docs/backlog/queue/PB-127-dead-file-citations-in-comments.md

A first all-text version also found four synthetic paths in test fixtures. That was a false
positive for this subject, so the rule was scoped to docs/ before the red queue measurement was
accepted. The two live task files were then normalized to workspace-relative wording; no archive
file was changed.

## Work to do

- Keep the absolute owner-home rule in scripts/audit-public.mjs assembled from fragments so the
  rule does not exempt itself.
- Keep the scope decision explicit: docs/archive/ is immutable historical evidence and is
  excluded; live docs/backlog/queue/ cards are included.
- Normalize the two live cards to a filename-relative or workspace-relative path, preserving the
  measured meaning without the owner's login or private repository root.
- Keep the reference README and CHANGELOG in the same pass.
- Prove the rule with a red queue measurement before the sweep, then run the green audit after
  the sweep.
- Run the mutation probe against the rule itself, not against a sanitized card. Mutating the
  archive guard to scan historical paths must produce the named absolute-owner-home verdict and
  the snapshot restore must return the green audit.

## Out of scope

- The brand exemption itself for evidence cards. It is a separate decision with its own reasons.
- Anything about the private consumer repository beyond removing its path from this tree.

## Verification

- Before the sweep, npm run audit exited 1 with exactly two findings, one for each live queue
  card named above.
- After the sweep, npm run audit must exit 0 and report the tracked-file and tarball counts.
- The mutation probe must target scripts/audit-public.mjs, exit 0 overall with a red mutated audit
  and a green restored audit, and name the absolute-owner-home verdict from docs/archive/.
- A final diff scan must find no absolute owner-home path in changed files and no foreign tracker or
  memory-service identifiers. Historical archive mentions remain unchanged by design.
- This card remains in the queue for approver acceptance; it is not archived here.
