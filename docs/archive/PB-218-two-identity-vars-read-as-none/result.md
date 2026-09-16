# PB-218 · Result

**Closed 2026-09-16, completed.** `resolveSessionIdentity` returned `null` both when nothing in the environment named a session and when more than one variable did, and the direct `worker` ↔ `approver` route refused the second case with the words "the calling harness supplied no session identity" — sending its reader to look for a variable that was there twice. The resolver now names its own state in `reason`: `resolved`, `none`, `contested` (more than one environment variable), `contested-records` (more than one MCP session record). Both contested states list the variables they found by name and say to remove the extra one; nothing is missing there. The refusal at several candidates is kept — silently preferring one variable would hand a participant someone else's identity, and `docs/reference/02-host.md` § Session identity says so in a sentence of its own. `contestedIdentity` and `sessionIdentityReport` in `lib/store.js` give the whole answer to the caller whose refusal must state a cause, and `requireDirectSender` now takes the scope `{home, task, address}` so that the `contested-records` case is named correctly too — without `home` a refusal over two MCP records would have claimed there was no identity at all.

**The text at zero variables is byte for byte the old one.** Not a matter of taste: the line `+ 'the calling harness supplied no session identity');` is quoted by a `quote` block in a closed card in the archive, and changing it would turn `backslop lint` red. The negative control on that text in `test/promptobus-mcp.test.mjs` sits next to the new check and was not touched.

**Verification.** Two mutation probes by the worker, each after a commit on a clean tree, restored from the pre-mutation snapshot:

- `npm run probe -- lib/drivers.js --mutate "s/reason: 'contested',/reason: 'none',/" --run "node test/session-identity.test.mjs"` → exit 0. The check "the two nulls are told apart by name" went red with the detail `{"none":"none","two":"none"}`.
- `npm run probe -- lib/store.js --mutate "s/if \(contestedIdentity\(said\)\) \{/if (false \&\& contestedIdentity(said)) {/" --run "node test/promptobus-mcp.test.mjs"` → exit 0. Mutated → exit 1 (the direct-route refusal fell back to the words "supplied no session identity"), restored → exit 0.

`test/promptobus-mcp.test.mjs` raises a live MCP child carrying two identity variables at once; `test/session-identity.test.mjs` adds five checks over the resolver itself. Gates of this acceptance, on this commit's tree: `npx github:Velklish/backslop#v0.8.0 gates --keep-going` exit 0 — gates 4, green 4 (`npm test` code 0, 67 of 67 test files; `backslop lint` code 0, errors 0; `npm run audit` code 0, 935 tracked text files and 133 packed entries, findings 0; `npm run pins` code 0, 935 of 935).

**What is left open.** The `contested-records` branch — two MCP session records at once — was not built end to end. Both branches run through `contestedIdentity`, which covers either state, but no stand with two valid records was raised: that is a hypothesis, not a measured fact.

**Documentation in the same pass.** `docs/reference/02-host.md` § Session identity, `CHANGELOG.md`.
