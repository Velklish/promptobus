# PB-11.2 · Result

**Closed 2026-09-05.** Completed. `HostClone` is exported from both entry points, and the entry-point check parses every `export interface` / `export type` out of `src/host.ts` (twelve, `PromptobusHost` included) with a floor instead of naming two by hand. Track `host` of the routing run, worker in Claude Code (opus, xhigh, bypassPermissions), one isolated review round (5 findings, all fixed). Gates on the track's tree: `npm test` 46/46 files, 1330 `check.mjs` verdicts and 560 `node:test` assertions, 0 failed; `npm run audit` clean; `backslop lint` clean; re-run on the merged `main` tree by the approver.

**Verification.** Probes: the name dropped from either list → red naming the entry; the declaration regex emptied → red on the floor; `HostClone` present in `dist/host-index.d.ts` and `dist/index.d.ts`.

**Documentation in the same pass.** `CHANGELOG.md`.
