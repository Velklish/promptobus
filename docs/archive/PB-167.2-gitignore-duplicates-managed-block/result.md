# PB-167.2 · Result

**Closed as dead weight removed, not as a defect fixed.** Thirteen hand-written adapter paths and
the comment above them restated what the managed `backslop:start` block already said, with
`/CLAUDE.md` listed twice; `.claude/worktrees/` moved up into the general section because it is
not an adapter output and the managed block does not cover it. `git diff --numstat`: 1 added, 16
removed.

Verified: `git check-ignore -v` on the five paths of the card named a rule for each — and named
the managed block for the four adapter paths **before** the cleanup as well, because git takes
the last matching rule, which is what makes this dead weight rather than a fix. `backslop init`
at the same pin then reported `.gitignore: unchanged` where the run that found this had reported
`appended`.

Outside the card: nothing. The managed block's own content is `init`'s and was not touched.

---
