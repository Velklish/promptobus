# PB-14.5 · Result

**Closed 2026-09-05.** Completed. The sweep sentinel in `test/tmpdir-sweep.test.mjs` now finds sandbox literals in both spellings of the temp directory (`os.tmpdir()` and an imported `tmpdir()`, `path.join` and a bare `join`, `mkdtempSync` alone or as `fs.mkdtempSync`): measured on the tree, the old pattern saw 44 literals with 0 uncovered, the widened one 61 literals with 8 uncovered prefixes, all now in `SUITE_PREFIXES` (`promptobus-routing-`, `promptobus-legacy-`, `pb-hooks-`, `pb-home-`, `pb-install-`; the `pb-` spellings kept as their files spell them). Track `robust` of the routing run, worker in Claude Code (opus, high), one isolated review round (no finding on this task).

**Verification.** `npm test` exit 0 — 45/45 files; `test/tmpdir-sweep.test.mjs` 17/17. Mutation probe, commit-first: `promptobus-routing-` removed from the list → the sentinel red naming six literals in three files (16/17); restored → 17/17. The narrow pattern with the full list stays green (the false-positive control). Gates re-run on the merged `main` tree by the approver.

**Documentation in the same pass.** `docs/guides/contributing.md` (the sweep list rule), `CHANGELOG.md` under `[Unreleased]`.
