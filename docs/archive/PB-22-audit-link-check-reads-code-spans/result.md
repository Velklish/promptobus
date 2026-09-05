# PB-22 · Result

**Closed 2026-09-05.** Completed by the approver. `scripts/audit-public.mjs` strips fenced blocks and inline code spans from a markdown file before the link pass, so a sentence that quotes the link pattern is no longer read as a link to its example; code files keep the comment-lines rule.

**Verification.** Probe with a temporarily tracked markdown: the pattern inside a code span and inside a fence → `npm run audit` exit 0; a real link to a missing file in the same file → exit 1 naming it. Gates re-run on `main` by the approver.

**Documentation in the same pass.** The script's comment; `CHANGELOG.md` `### Fixed`.
