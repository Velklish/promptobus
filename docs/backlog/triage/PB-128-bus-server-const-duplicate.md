# PB-128 · src/hooks.ts declares BUS_SERVER under a comment claiming the package has no contract.js, though lib/contract.js declares the same server name with no test tying the two together

- **Scope:** [reference/01-overview](../../reference/01-overview.md) (already names `lib/contract.js` as this package's file), `src/hooks.ts`, `lib/contract.js`, `test/hooks.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Confirmed against current HEAD (v0.5.0). `src/hooks.ts:14-17` reads: "Bus server name. The package has no `contract.js` of its own, and the literal here is not a copy of a consumer constant, it is a package declaration. Drift from the server name breaks the staged-hook matcher: the group is not found." followed by `export const BUS_SERVER = 'promptobus';` and `export const BUS_HOOK_MATCHER = \`mcp__${BUS_SERVER}__(promptobus_send|promptobus_mailbox)\`;`. But `lib/contract.js:24` independently declares `export const PROMPTOBUS_SERVER = 'promptobus';` in the SAME package, imported by nine `lib/` modules (`server.js:7`, `driver-claude.js:7`, `driver-codex.js:3`, `driver-cursor.js:7`, `cursor-persist.js:11`, `spawn.js:18,88`, `review.js:18`). `docs/reference/01-overview.md:56` already cites `lib/contract.js` for a neighbouring constant, so the comment's premise ("the package has no contract.js of its own") is false today, not merely imprecise. `grep -rn "BUS_SERVER" test/*.mjs` and `grep -n "BUS_SERVER" test/hooks.test.mjs` both return nothing — no test compares the two constants.

Git history shows this was once guarded and the guard was lost, not that separation is deliberate: `git log --follow -p -- src/hooks.ts` shows the comment originally (commit `5898217`) read "Drift from `PROMPTOBUS_SERVER` is caught by `sync.test.mjs`" — a real gate from the former parent layout. Commit `b0700b5` rewrote the comment to drop the now-nonexistent `sync.test.mjs` reference but kept the "package has no contract.js of its own" line, even though `lib/contract.js` was present in the package from the same original snapshot commit `5898217` onward.

Both constants are load-bearing in the same flow: `PROMPTOBUS_SERVER` is the MCP config key (`driver-codex.js:79`) and `serverInfo.name` (`server.js:126`); `BUS_SERVER` builds `BUS_HOOK_MATCHER`, which the installed `PostToolUse` hook (consuming `dist/hooks.js` via `lib/install.js`) must match against `mcp__<PROMPTOBUS_SERVER>__...`. If one is renamed and not the other, the participant's MCP config key stops matching the hook matcher and the bus feed goes silent for that session — with the suite staying green, since no test reads `BUS_SERVER`. Not already tracked: grepped `docs/backlog` and `docs/archive` for contract.js/PROMPTOBUS_SERVER/BUS_SERVER/hooks.ts — nothing.

## Work to do

- Correct the comment in `src/hooks.ts` to state the actual fact: `lib/contract.js` exists in this package and declares the same server name.
- Remove the duplicate literal: either import `PROMPTOBUS_SERVER` from `lib/contract.js` into `src/hooks.ts` (contract.js is a dependency-free leaf, so no cycle — needs `allowJs` for this one file or a thin `.d.ts`), or add a same-value assertion in `test/hooks.test.mjs` comparing `dist/hooks.js`'s `BUS_SERVER` against `lib/contract.js`'s `PROMPTOBUS_SERVER`, restoring the kind of gate the old `sync.test.mjs` used to provide.
- No CHANGELOG entry: the server name value itself does not change; this is a dedup/comment fix.

## Out of scope

- Renaming either constant, or changing the bus server name — both already agree on `'promptobus'`; this only removes the unguarded duplicate.
- Restoring `sync.test.mjs` itself — that test belonged to a parent layout this package no longer has; a new, local gate is what's needed, not the old file.

## Verification

- `grep -n "contract.js" src/hooks.ts` shows the corrected comment.
- If a same-value test is chosen: change `PROMPTOBUS_SERVER` in `lib/contract.js` without touching `src/hooks.ts` — `npm test` fails on the new assertion; revert and it passes again.
- If the import path is chosen: `BUS_HOOK_MATCHER` still builds to `mcp__promptobus__(promptobus_send|promptobus_mailbox)` and `npm test` stays green.
