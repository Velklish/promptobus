# PB-119 · PROMPTOBUS_SERVER/BUS_SERVER and GUARD_HOOK_EVENT each have two independent, comment-claimed-sole-home declarations across src/ and lib/, and no suite check ties either pair together

- **Scope:** `lib/contract.js`, `src/hooks.ts`, `lib/driver-claude.js`, `test/promptobus-package.test.mjs`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Verified against HEAD, package.json version 0.5.0. Pair one: `lib/contract.js:1-2` opens "Bus-contract values cited in prose... This is their only home", and `:24` declares `export const PROMPTOBUS_SERVER = 'promptobus';`. Independently, `src/hooks.ts:14-16` states "Bus server name. The package has no `contract.js` of its own, and the literal here is not a copy of a consumer constant, it is a package declaration" — false today — then `:17` declares `export const BUS_SERVER = 'promptobus';`, feeding `BUS_HOOK_MATCHER` at `:18`. Pair two: `src/hooks.ts:20` declares `export const GUARD_HOOK_EVENT = 'Stop';`; `lib/driver-claude.js:695-699` carries its own comment — "it has one home for two doors: the workspace layout (`guardhook.js`) and the participant settings file" — before redeclaring `const GUARD_HOOK_EVENT = 'Stop';` at `:700`. `guardhook.js` does not exist in this repository (`find . -iname guardhook.js` under promptobus returns nothing); it lives at `/Users/kim.p/AtiWorkspace/workspace/repos/agent-workspace/ati-agents/cli/lib/guardhook.js` — a different repository this package must not know about. `grep -rn BUS_SERVER test/` and `grep -n PROMPTOBUS_SERVER test/promptobus-package.test.mjs` both return nothing: no test holds either pair equal. The repo's own precedent for this exact risk is `lib/store.js:70-73`'s `FALLBACK_HARNESS`, held equal to `REGISTRY.fallback` by a live suite assertion — these two pairs have no equivalent. Four `lib/` modules (`guard.js`, `install.js`, `review.js`, `spawn.js`) already import from `../dist/hooks.js`, so the import direction a fix would need is already established practice. Not tracked: no backlog or archive entry mentions `PROMPTOBUS_SERVER`, `BUS_SERVER`, or `GUARD_HOOK_EVENT`.

## Work to do

- Pick one fix per pair. Either re-export from dist — `export { BUS_SERVER as PROMPTOBUS_SERVER } from '../dist/hooks.js'` in `contract.js`, and `import { GUARD_HOOK_EVENT } from '../dist/hooks.js'` in `driver-claude.js` in place of the local `const` — accepting that `contract.js` loses the zero-import "leaf module" property its own header claims; or keep both literals and add one-line suite assertions (`BUS_SERVER === PROMPTOBUS_SERVER`; `GUARD_HOOK_EVENT` compared between `src/hooks.ts` and `driver-claude.js`) to `test/promptobus-package.test.mjs`, mirroring the `FALLBACK_HARNESS`/`REGISTRY.fallback` check in `lib/store.js`.
- Fix the two stale comments regardless of which route is taken: `src/hooks.ts:14-15`'s claim that the package has no `contract.js`, and `driver-claude.js`'s pointer to `guardhook.js` — name `src/hooks.ts` instead, since that file is this package's actual second home.
- If the literals stay separate, correct `contract.js:1-2`'s "this is their only home" to acknowledge the package-side declaration.

## Out of scope

- The rest of `contract.js`'s contents (tool list, message types) — unrelated to these two constants.
- Changing the actual values — both read `promptobus` and `Stop` today; this only ties the existing declarations of each together.

## Verification

- If the re-export route is taken: `grep -n "from '../dist/hooks.js'" lib/contract.js` finds the new import, and `node -e "console.log(require('./lib/contract.js').PROMPTOBUS_SERVER)"` still prints `promptobus`.
- If the suite-assertion route is taken: the new check in `test/promptobus-package.test.mjs` is red against a one-line mutation that renames `PROMPTOBUS_SERVER` (or `GUARD_HOOK_EVENT` in `driver-claude.js`) to a different literal, and green otherwise.
- `npm test` stays green; `backslop lint` stays clean.
