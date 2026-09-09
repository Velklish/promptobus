# PB-97 · Result

**Closed 2026-09-09.** Completed. Dispatch JSON-RPC messages by method before consulting pending client ids. A colliding server request is answered without resolving the client promise; unmatched responses are logged by id only.

**Verification.** The final suite includes test/codex-rpc.test.mjs: 5/5. The same new test on baseline 284ca62 reproduced the defect: 1/5, exit 1, reported in bus message 20260908T114753425-0003-df7117.json; after the fix: 5/5, exit 0.

Independent final gates on `a79114d501c3d364473e7e64435d4e900ead0f7a`, clean checkout: `npm test` — 52/52 test files, exit 0; `npx github:Velklish/backslop#v0.4.0 lint` — 0 errors, exit 0; `npm run audit` — 576 tracked files and 119 tarball entries, exit 0. Logs under `/private/tmp/promptobus-codex-run`: `reviewer-a79114d-npm-test.log`, `reviewer-a79114d-lint.log`, `reviewer-a79114d-audit.log`. Runtime and tests are unchanged by acceptance; task movement and these results are documentation only.

**Documentation in the same pass.** `docs/reference/03-cli.md`, `CHANGELOG.md`, and the archived task/result. Archive link rewrites are checked by backslop lint.

**Acceptance.** Implementation: Cursor `cursor-grok-4.6-xhigh-fast`. Review and final live verification: the requesting session's Codex reviewer. Integrated into `codex/codex-lifecycle-repair`; no main merge or publication.
