# PB-90 · Result

**Closed 2026-09-09.** Completed. Send config.model_reasoning_effort on thread/start for both roles and preserve effort on the first turn/start. Keep the reviewer role and read-only sandbox. The installed CLI echoes the requested thread effort; later wakes inherit the turn override.

**Verification.** No-turn probe node /private/tmp/promptobus-codex-run/worker-evidence/pb90-thread-start-effort.mjs on codex-cli 0.146.0 returned requested low and xhigh, exit 0; reviewer-pb90-effort.json. Worker mutations removing config effort or first-turn effort produced 84/86 and 85/86 respectively (worker-evidence/pb90-mutation-*.log). Final driver suite: 86/86.

Independent final gates on `a79114d501c3d364473e7e64435d4e900ead0f7a`, clean checkout: `npm test` — 52/52 test files, exit 0; `npx github:Velklish/backslop#v0.4.0 lint` — 0 errors, exit 0; `npm run audit` — 576 tracked files and 119 tarball entries, exit 0. Logs under `/private/tmp/promptobus-codex-run`: `reviewer-a79114d-npm-test.log`, `reviewer-a79114d-lint.log`, `reviewer-a79114d-audit.log`. Runtime and tests are unchanged by acceptance; task movement and these results are documentation only.

**Documentation in the same pass.** `docs/reference/03-cli.md`, `CHANGELOG.md`, and the archived task/result. Archive link rewrites are checked by backslop lint.

**Acceptance.** Implementation: Cursor `cursor-grok-4.6-xhigh-fast`. Review and final live verification: the requesting session's Codex reviewer. Integrated into `codex/codex-lifecycle-repair`; no main merge or publication.
