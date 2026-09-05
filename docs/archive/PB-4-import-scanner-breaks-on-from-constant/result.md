# PB-4 · Result

**Closed 2026-09-05.** Completed. `test/promptobus-package.test.mjs` scans imports by tokens, not text: one pass over comments, strings, template literals with interpolation and regex literals, then a reader that consumes the exact import / re-export clause and gives up when the shape does not hold — so `export const MESSAGE_FROM = ' from ';` stops at the identifier. Measured on the two new fixtures (`test/fixtures/import-scan/`): the pre-fix pattern returned a broken specifier and never saw the external package after the trap; the pattern that was on `main` invented a package name from a string literal and never matched `import a, { b } from …`, so an external import in that form was invisible — a live hole closed with the reported one. A specifier written as a template literal is not resolved (documented). `test/boundary.test.mjs` keeps its own weaker guard, out of scope by the entry. Track `cli`, same worker and review round.

**Verification.** `promptobus-package.test.mjs` 19/19; substitution probe: the old pattern dropped in front of the tokenizer → the trap check red on its first line. Gates re-run on the merged `main` tree by the approver.

**Documentation in the same pass.** The fixtures and the file header; `CHANGELOG.md`.
