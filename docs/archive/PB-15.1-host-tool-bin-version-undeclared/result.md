# PB-15.1 · Result

**Closed 2026-09-05.** Completed. `HostToolBin.version` is declared (optional; absent means unread, never old). `createStandaloneHost` keeps returning none on purpose — it hands the name back without searching, and a version would cost a process start inside a synchronous resolve — and `docs/reference/02-host.md` § Tool binaries says so. A check parses `HostToolBin` from `src/host.ts`, finds in the three drivers and three adapters what each holds a resolved bin under, and refuses an undeclared read (with an anti-vacuity floor on the reader count). Track `host` of the routing run, worker in Claude Code (opus, xhigh, bypassPermissions), one isolated review round (5 findings, all fixed). Gates on the track's tree: `npm test` 46/46 files, 1330 `check.mjs` verdicts and 560 `node:test` assertions, 0 failed; `npm run audit` clean; `backslop lint` clean; re-run on the merged `main` tree by the approver.

**Verification.** Probes, commit-first: the declaration dropped → red; a planted `tool.bogusField` → red naming file and field; the reader glob emptied → red on the floor; type probe: `version: 2` is a TS2322 at the declaration.

**Documentation in the same pass.** `docs/reference/02-host.md`, `CHANGELOG.md`.
