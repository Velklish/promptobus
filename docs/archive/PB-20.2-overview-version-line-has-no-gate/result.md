# PB-20.2 · Result

**Closed 2026-09-05.** Completed by the approver. `test/promptobus-package.test.mjs` compares the hand-written version line of `docs/reference/01-overview.md` with `package.json`; the line moves in the release commit and the suite refuses a tree where it did not. The overview paragraph that said no gate existed now names the gate.

**Verification.** `promptobus-package.test.mjs` 20/20; probe, commit-first: the line changed to `0.0.0` → red naming both numbers. Gates re-run on `main` by the approver.

**Documentation in the same pass.** `docs/reference/01-overview.md`.
