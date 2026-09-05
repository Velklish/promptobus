# PB-9.1 · Result

**Closed 2026-09-05.** Completed, per check. `promptobus-host.test.mjs`: both checks kept with the dead Russian half of each `||` removed (11/11, no Cyrillic left). `promptobus-mcp.test.mjs`: five checks that were a vacuous negation and nothing else deleted — each one's real invariant is asserted positively against the same string a few lines away — and the sixth kept with its real half; 110 → 105 checks, dead-hint occurrences 8 → 0. Track `host` of the routing run, worker in Claude Code (opus, xhigh, bypassPermissions), one isolated review round (5 findings, all fixed). Gates on the track's tree: `npm test` 46/46 files, 1330 `check.mjs` verdicts and 560 `node:test` assertions, 0 failed; `npm run audit` clean; `backslop lint` clean; re-run on the merged `main` tree by the approver.

**Verification.** Probes: the template header changed → both host checks red; the header swapped to the Russian spelling → both red (the removed branch used to accept a string the project does not ship); the mailbox body rendered empty → the kept mcp check red.

**Documentation in the same pass.** `CHANGELOG.md`.
