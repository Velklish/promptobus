# PB-119 · PROMPTOBUS_SERVER/BUS_SERVER and GUARD_HOOK_EVENT each have two independent, comment-claimed-sole-home declarations across src/ and lib/, and no suite check ties either pair together

- **Order:** 60
- **Scope:** `lib/contract.js`, `src/hooks.ts`, `lib/driver-claude.js`, `test/promptobus-package.test.mjs`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Verified against HEAD, package.json version 0.5.0. Pair one: `lib/contract.js:1-2` opens "Bus-contract values cited in prose... This is their only home", and `:24` declares `export const PROMPTOBUS_SERVER = 'promptobus';`. Independently, `src/hooks.ts:14-16` states "Bus server name. The package has no `contract.js` of its own, and the literal here is not a copy of a consumer constant, it is a package declaration" — false today — then `:17` declares `export const BUS_SERVER = 'promptobus';`, feeding `BUS_HOOK_MATCHER` at `:18`. Pair two: `src/hooks.ts:20` declares `export const GUARD_HOOK_EVENT = 'Stop';`; `lib/driver-claude.js:695-699` carries its own comment — "it has one home for two doors: the workspace layout (`guardhook.js`) and the participant settings file" — before redeclaring `const GUARD_HOOK_EVENT = 'Stop';` at `:700`. `guardhook.js` does not exist in this repository (`find . -iname guardhook.js` under promptobus returns nothing); it lives at `/Users/kim.p/AtiWorkspace/workspace/repos/agent-workspace/consumer-cli/cli/lib/guardhook.js` — a different repository this package must not know about. `grep -rn BUS_SERVER test/` and `grep -n PROMPTOBUS_SERVER test/promptobus-package.test.mjs` both return nothing: no test holds either pair equal. The repo's own precedent for this exact risk is `lib/store.js:70-73`'s `FALLBACK_HARNESS`, held equal to `REGISTRY.fallback` by a live suite assertion — these two pairs have no equivalent. Four `lib/` modules (`guard.js`, `install.js`, `review.js`, `spawn.js`) already import from `../dist/hooks.js`, so the import direction a fix would need is already established practice. Not tracked: no backlog or archive entry mentions `PROMPTOBUS_SERVER`, `BUS_SERVER`, or `GUARD_HOOK_EVENT`.

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

## Consolidated evidence from PB-86

### PB-86 · src/hooks.ts declares its own BUS_SERVER constant on a comment claiming promptobus has no contract.js of its own, though lib/contract.js independently declares PROMPTOBUS_SERVER and both are shipped with nothing comparing them

- **Scope:** `src/hooks.ts`, `lib/contract.js`, [reference/03-cli](../../reference/03-cli.md) § MCP
- **Created:** 2026-09-06
- **Recorded dependencies:** none

### Context

`src/hooks.ts:14-18`: 'Bus server name. The package has no `contract.js` of its own, and the literal here is not a copy of a consumer constant, it is a package declaration.' followed by `export const BUS_SERVER = 'promptobus';`. The comment is false today: `lib/contract.js:24` independently declares `export const PROMPTOBUS_SERVER = 'promptobus';`, and it ships — `package.json`'s `files` field lists `lib` (re-checked now with `grep -n '"files"' -A5 package.json`). Unlike `lib/host.js` and `lib/harness-home.js`, which re-export from `../dist/...` (confirmed by reading their headers), `lib/contract.js`'s own header says 'The module is a leaf — it has no imports of its own': it is genuinely hand-written and independent, not generated from `src/hooks.ts` or anything else in `src/`.

Both values back live consumers. `BUS_SERVER` feeds `BUS_HOOK_MATCHER` (`src/hooks.ts:18`), the regex the project-level `PostToolUse` hook uses to recognize bus tool calls. `PROMPTOBUS_SERVER` is imported by 7 other `lib/` modules — `cursor-persist.js`, `driver-claude.js`, `driver-codex.js`, `driver-cursor.js`, `review.js`, `server.js`, and twice by `spawn.js` — and is quoted in prose at `docs/reference/03-cli.md:703` ('The bus server name is `promptobus`.').

Nothing compares the two literals: `grep -rn BUS_SERVER test/` returns nothing, and `test/hooks.test.mjs:92` only asserts `assert.match(codex.hooks.PostToolUse[0].matcher, /promptobus_send/);` — it never touches `PROMPTOBUS_SERVER`. The only existing cross-check is external and one-directional: consumer-cli' `cli/test/promptobus-host.test.mjs:91-92` compares consumer-cli' own literal against the package's *compiled* `dist/hooks.js` value, protecting consumer-cli from drifting away from `hooks.ts` — it does nothing for drift between `hooks.ts` and `contract.js` inside promptobus itself, and a standalone consumer of the published package (no consumer-cli suite) has no protection at all.

No backlog or archive entry tracks this (grepped `docs/backlog` and `docs/archive` for `BUS_SERVER`/`PROMPTOBUS_SERVER`/`contract.js`/`hooks.ts` — no hits), and `contract.js`'s own header explains why harness-specific values were moved OUT of it but says nothing about `hooks.ts` keeping a second copy of the server name — the stale comment reads as an oversight, not a recorded decision.

### Work to do

- Move the server-name declaration to a new `src/contract.ts` (`export const PROMPTOBUS_SERVER = 'promptobus';`), and have `src/hooks.ts` import `BUS_SERVER` from it instead of declaring its own literal.
- Make `lib/contract.js` re-export the compiled value from `../dist/contract.js` instead of declaring its own literal, following the lib→dist pattern already used by `lib/host.js` and `lib/harness-home.js`.
- Fix the stale 'The package has no contract.js of its own' comment in `src/hooks.ts` to describe the corrected single source of truth.
- Add a test asserting `BUS_SERVER === PROMPTOBUS_SERVER` so a future edit to either cannot silently diverge inside the package.

### Out of scope

- consumer-cli' `cli/test/promptobus-host.test.mjs` cross-check against `dist/hooks.js` — already correct, untouched by this entry.
- Renaming `PROMPTOBUS_SERVER`/`BUS_SERVER` or changing the bus server's actual name — this is a single-source-of-truth fix, not a rename.

### Verification

- After the change, `src/contract.ts` is the only module declaring the literal `'promptobus'` for the bus server; `lib/contract.js`'s `PROMPTOBUS_SERVER` and `src/hooks.ts`'s `BUS_SERVER` both trace to an import of it.
- The new equality test fails on a deliberately mismatched pair of literals (mutation probe) and passes on the merged code.
- `npm test` green.

## Consolidated evidence from PB-128

### PB-128 · src/hooks.ts declares BUS_SERVER under a comment claiming the package has no contract.js, though lib/contract.js declares the same server name with no test tying the two together

- **Scope:** [reference/01-overview](../../reference/01-overview.md) (already names `lib/contract.js` as this package's file), `src/hooks.ts`, `lib/contract.js`, `test/hooks.test.mjs`
- **Created:** 2026-09-06
- **Recorded dependencies:** none

### Context

Confirmed against current HEAD (v0.5.0). `src/hooks.ts:14-17` reads: "Bus server name. The package has no `contract.js` of its own, and the literal here is not a copy of a consumer constant, it is a package declaration. Drift from the server name breaks the staged-hook matcher: the group is not found." followed by `export const BUS_SERVER = 'promptobus';` and `export const BUS_HOOK_MATCHER = \`mcp__${BUS_SERVER}__(promptobus_send|promptobus_mailbox)\`;`. But `lib/contract.js:24` independently declares `export const PROMPTOBUS_SERVER = 'promptobus';` in the SAME package, imported by nine `lib/` modules (`server.js:7`, `driver-claude.js:7`, `driver-codex.js:3`, `driver-cursor.js:7`, `cursor-persist.js:11`, `spawn.js:18,88`, `review.js:18`). `docs/reference/01-overview.md:56` already cites `lib/contract.js` for a neighbouring constant, so the comment's premise ("the package has no contract.js of its own") is false today, not merely imprecise. `grep -rn "BUS_SERVER" test/*.mjs` and `grep -n "BUS_SERVER" test/hooks.test.mjs` both return nothing — no test compares the two constants.

Git history shows this was once guarded and the guard was lost, not that separation is deliberate: `git log --follow -p -- src/hooks.ts` shows the comment originally (commit `5898217`) read "Drift from `PROMPTOBUS_SERVER` is caught by `sync.test.mjs`" — a real gate from the former parent layout. Commit `b0700b5` rewrote the comment to drop the now-nonexistent `sync.test.mjs` reference but kept the "package has no contract.js of its own" line, even though `lib/contract.js` was present in the package from the same original snapshot commit `5898217` onward.

Both constants are load-bearing in the same flow: `PROMPTOBUS_SERVER` is the MCP config key (`driver-codex.js:79`) and `serverInfo.name` (`server.js:126`); `BUS_SERVER` builds `BUS_HOOK_MATCHER`, which the installed `PostToolUse` hook (consuming `dist/hooks.js` via `lib/install.js`) must match against `mcp__<PROMPTOBUS_SERVER>__...`. If one is renamed and not the other, the participant's MCP config key stops matching the hook matcher and the bus feed goes silent for that session — with the suite staying green, since no test reads `BUS_SERVER`. Not already tracked: grepped `docs/backlog` and `docs/archive` for contract.js/PROMPTOBUS_SERVER/BUS_SERVER/hooks.ts — nothing.

### Work to do

- Correct the comment in `src/hooks.ts` to state the actual fact: `lib/contract.js` exists in this package and declares the same server name.
- Remove the duplicate literal: either import `PROMPTOBUS_SERVER` from `lib/contract.js` into `src/hooks.ts` (contract.js is a dependency-free leaf, so no cycle — needs `allowJs` for this one file or a thin `.d.ts`), or add a same-value assertion in `test/hooks.test.mjs` comparing `dist/hooks.js`'s `BUS_SERVER` against `lib/contract.js`'s `PROMPTOBUS_SERVER`, restoring the kind of gate the old `sync.test.mjs` used to provide.
- No CHANGELOG entry: the server name value itself does not change; this is a dedup/comment fix.

### Out of scope

- Renaming either constant, or changing the bus server name — both already agree on `'promptobus'`; this only removes the unguarded duplicate.
- Restoring `sync.test.mjs` itself — that test belonged to a parent layout this package no longer has; a new, local gate is what's needed, not the old file.

### Verification

- `grep -n "contract.js" src/hooks.ts` shows the corrected comment.
- If a same-value test is chosen: change `PROMPTOBUS_SERVER` in `lib/contract.js` without touching `src/hooks.ts` — `npm test` fails on the new assertion; revert and it passes again.
- If the import path is chosen: `BUS_HOOK_MATCHER` still builds to `mcp__promptobus__(promptobus_send|promptobus_mailbox)` and `npm test` stays green.

## Triage — 2026-09-07

- **Track:** H — Hook installation and host commands.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/contract.js:1`, `src/hooks.ts:14`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Includes PB-86 and PB-128 for the server-name pair, plus its distinct guard-event pair. Prefer one dependency-safe compiled source; do not enable project-wide allowJs only to remove one constant. Complete before driver/hook tracks share these declarations.
