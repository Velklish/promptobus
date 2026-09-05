# PB-20.1 · Result

**Closed 2026-09-05.** Completed by the approver on the owner's decision to do it before the release. The text form of `models` prints at most `RUNTIME_ROWS_PER_HARNESS` (8) unrated rows per harness and counts the rest on one line (`<harness>: … and N more — every row is in --json`); the decision document and `--json` keep every row, so the two outputs cannot drift. The golden `models.txt` (one runtime row) is unchanged.

**Verification.** `test/model-routing-resolver.test.mjs` 49/49 (new check: twelve unrated rows on one harness → eight printed and the count line, the document carrying all twelve); probe, commit-first: the cap removed → red. Gates re-run on `main` by the approver.

**Documentation in the same pass.** `docs/reference/03-cli.md` (the `models` paragraph names the cap), `CHANGELOG.md` (one clause in the routing bullet).
