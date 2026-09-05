# PB-13.3 · Result

**Closed 2026-09-05.** Completed by the owner's decision: an allow/deny list stays non-clearable — a higher layer replaces a list, it cannot clear one, so a consumer policy ban holds whatever a workspace file says (changing it means changing the layer that wrote it). ADR-003 § Overlays carries a dated clarification of the same decision (no supersede, no schema change); `docs/reference/03-cli.md` states the rule plainly and the guide's pointer to this task is replaced by the decision. Track `host` of the routing run, worker in Claude Code (opus, xhigh, bypassPermissions), one isolated review round (5 findings, all fixed). Gates on the track's tree: `npm test` 46/46 files, 1330 `check.mjs` verdicts and 560 `node:test` assertions, 0 failed; `npm run audit` clean; `backslop lint` clean; re-run on the merged `main` tree by the approver.

**Verification.** `backslop lint` and `npm run audit` clean; the guide and the reference read the same rule.

**Documentation in the same pass.** `docs/adr/adr-003-model-routing.md`, `docs/reference/03-cli.md`, `docs/guides/model-routing.md`, `CHANGELOG.md`.
