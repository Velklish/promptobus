# PB-99 · Result

**Closed 2026-09-09.** Completed. Report a dead, nameless starting holder as stale when the record contains an error or exceeds readyMs. Preserve the rising grace period for a fresh record. Status exposes LISTED and the relift route.

**Verification.** The final suite includes test/codex-inspect.test.mjs: 17/17 and the driver LISTED output check. Worker mutation restored unbounded rising and reported 2/5 instead of 5/5 in bus message 20260908T115234502-0006-35cae3.json.

Independent final gates on `a79114d501c3d364473e7e64435d4e900ead0f7a`, clean checkout: `npm test` — 52/52 test files, exit 0; `npx github:Velklish/backslop#v0.4.0 lint` — 0 errors, exit 0; `npm run audit` — 576 tracked files and 119 tarball entries, exit 0. Logs under `/private/tmp/promptobus-codex-run`: `reviewer-a79114d-npm-test.log`, `reviewer-a79114d-lint.log`, `reviewer-a79114d-audit.log`. Runtime and tests are unchanged by acceptance; task movement and these results are documentation only.

**Documentation in the same pass.** `docs/reference/03-cli.md`, `CHANGELOG.md`, and the archived task/result. Archive link rewrites are checked by backslop lint.

**Acceptance.** Implementation: Cursor `cursor-grok-4.6-xhigh-fast`. Review and final live verification: the requesting session's Codex reviewer. Integrated into `codex/codex-lifecycle-repair`; no main merge or publication.
