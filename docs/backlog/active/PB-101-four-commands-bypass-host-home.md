# PB-101 · `status`, `history`, `prune` and `dismiss` rebuild the store path from the workspace root instead of asking the host, so a host that declares its own home gets four commands reading an empty bus

- **Scope:** `lib/status.js`, `lib/history.js`, `lib/dismiss.js`, `lib/prune.js`, `lib/store.js` (`promptobusHome`), [reference/02-host.md](../../reference/02-host.md) section What the host must answer
- **Created:** 2026-09-06
- **Dependencies:** PB-102
- **Taken:** 2026-09-09

## Context

Four commands rebuild the store path from the root instead of asking the host: `lib/status.js:157`, `lib/history.js:68`, `lib/dismiss.js:28`, `lib/prune.js:150` all read

```js
const home = promptobusHome(host.workspaceRoot(), host);
```

and that helper (`lib/store.js:75-80`) returns `path.join(root, PROMPTOBUS_REL)`, ignoring what `host.promptobusHome()` itself would answer. Three commands take the host's own answer instead: `lib/spawn.js:524`, `lib/review.js:105` and `:162`, `lib/done.js:312` - all `const home = host.promptobusHome();`.

The host contract makes the member the answer: `src/host.ts:192` declares `promptobusHome(): string`, and `docs/reference/02-host.md:12` (Roots) and `:57` ("promptobusHome() names the workspace layer and nothing else") name it as such. `src/standalone.ts:138` honours an explicit `home` option: `const home = options.home ?? homeOfRoot(root);`.

Verified now: a standalone host built with `home: <sandbox>/bus-elsewhere` answers that path from `host.promptobusHome()`, while the store door built from `workspaceRoot()` answers `<sandbox>/ws/.promptobus` - a different directory. A task created via `store.createTask(host.promptobusHome(), ...)` then made `status(host, {})` print no active tasks - silently, with no error anywhere.

Nothing is broken today: `bin/promptobus.js:27-33` passes no `home`, and consumer-cli's `cli/bin/agents.js:342-346` passes an explicit `root` for every bus subcommand, so its host member (`cli/lib/promptobus/ati-host.js:125-129`, `busHome()` -> `storeHome(workspaceRoot)`) equals the same path the four commands build by construction - the split is latent, not live, for either shipped host.

## Work to do

- Replace the four call sites (`lib/status.js:157`, `lib/history.js:68`, `lib/dismiss.js:28`, `lib/prune.js:150`) with `host.promptobusHome()`, matching `lib/spawn.js`, `lib/review.js` and `lib/done.js`.
- Re-word the `lib/store.js:112-117` comment so it describes what it actually counts (migration entries) - it does not license the split found here.
- Add a suite check that no `lib/*.js` command resolves the store by joining `host.workspaceRoot()` with `PROMPTOBUS_REL` directly.
- Note in the CHANGELOG that the swap loses no legacy-layout migration on either shipped host: the ATI host's member already routes through the store door, and the standalone host declares `legacyLayout() === null`, for which `preflight` reports `needed:false`.

## Out of scope

- Changing `promptobusHome()`'s own contract or the standalone `home` option - this is a call-site fix, not a contract change.
- A future explicit `home` override on the ATI host (e.g. liftHarness, set substitution) that deliberately skips migration - after this fix those four commands follow it too, which is the intended reading of the contract, not a regression to guard against here.

## Verification

- Standalone host with an explicit `home` differing from `<workspaceRoot>/.promptobus`: `status`, `history`, `dismiss` and `prune` all read the same store as `spawn`/`review`/`done` after the fix (today they silently read an empty one).
- The new suite check for the bypass pattern is red before the fix and green after.
- `npm test`.

## Triage — 2026-09-07

- **Track:** S — Store integrity and public engine.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/status.js:157`, `lib/history.js:68`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
