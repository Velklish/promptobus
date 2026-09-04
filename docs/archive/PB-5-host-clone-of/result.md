# PB-5 · Result

**Closed 2026-09-05.** Done.

`cloneOf(abs): HostClone | null` replaces `reposRoot()` in the host contract; `need-pair` and `cwd-need-pair` are gone from `reviewLayoutError`. The review gate asks the host which clone the target belongs to and how it is named, and walks nothing itself. Standalone `cloneOf` descends from the root to the first `.git` below it, as the old walk did; the root itself is never a clone. Verified: `host.test.mjs` (nested clone, group folder, root, outside), the review fixture refusals unchanged (`outside the workspace`, `clone not found`), 38/38 test files, publicity audit clean. Released as v0.2.0; the ATI host implements `cloneOf` with two zones on its side.
