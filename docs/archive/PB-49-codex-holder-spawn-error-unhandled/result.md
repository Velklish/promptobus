# PB-49 · Result

**Closed 2026-09-09.** Completed. Handle app-server spawn errors with failHold and retain the original error in the session. Attach pipe error listeners so a dead stdin cannot crash the holder with an unhandled EPIPE.

**Verification.** The final suite includes test/codex-holder-spawn.test.mjs: 5/5. Its closed-stdin handshake forces the write after closure. Removing the pipe listeners after committing produced 4/5, exit 1; worker evidence: worker-evidence/pb49-pipe-mutation.log.

Independent final gates on `a79114d501c3d364473e7e64435d4e900ead0f7a`, clean checkout: `npm test` — 52/52 test files, exit 0; `npx github:Velklish/backslop#v0.4.0 lint` — 0 errors, exit 0; `npm run audit` — 576 tracked files and 119 tarball entries, exit 0. Logs under `/private/tmp/promptobus-codex-run`: `reviewer-a79114d-npm-test.log`, `reviewer-a79114d-lint.log`, `reviewer-a79114d-audit.log`. Runtime and tests are unchanged by acceptance; task movement and these results are documentation only.

**Documentation in the same pass.** `docs/reference/03-cli.md`, `CHANGELOG.md`, and the archived task/result. Archive link rewrites are checked by backslop lint.

**Acceptance.** Implementation: Cursor `cursor-grok-4.6-xhigh-fast`. Review and final live verification: the requesting session's Codex reviewer. Integrated into `codex/codex-lifecycle-repair`; no main merge or publication.
