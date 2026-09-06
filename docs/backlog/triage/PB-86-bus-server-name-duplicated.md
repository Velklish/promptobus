# PB-86 · src/hooks.ts declares its own BUS_SERVER constant on a comment claiming promptobus has no contract.js of its own, though lib/contract.js independently declares PROMPTOBUS_SERVER and both are shipped with nothing comparing them

- **Scope:** `src/hooks.ts`, `lib/contract.js`, [reference/03-cli](../../reference/03-cli.md) § MCP
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`src/hooks.ts:14-18`: 'Bus server name. The package has no `contract.js` of its own, and the literal here is not a copy of a consumer constant, it is a package declaration.' followed by `export const BUS_SERVER = 'promptobus';`. The comment is false today: `lib/contract.js:24` independently declares `export const PROMPTOBUS_SERVER = 'promptobus';`, and it ships — `package.json`'s `files` field lists `lib` (re-checked now with `grep -n '"files"' -A5 package.json`). Unlike `lib/host.js` and `lib/harness-home.js`, which re-export from `../dist/...` (confirmed by reading their headers), `lib/contract.js`'s own header says 'The module is a leaf — it has no imports of its own': it is genuinely hand-written and independent, not generated from `src/hooks.ts` or anything else in `src/`.

Both values back live consumers. `BUS_SERVER` feeds `BUS_HOOK_MATCHER` (`src/hooks.ts:18`), the regex the project-level `PostToolUse` hook uses to recognize bus tool calls. `PROMPTOBUS_SERVER` is imported by 7 other `lib/` modules — `cursor-persist.js`, `driver-claude.js`, `driver-codex.js`, `driver-cursor.js`, `review.js`, `server.js`, and twice by `spawn.js` — and is quoted in prose at `docs/reference/03-cli.md:703` ('The bus server name is `promptobus`.').

Nothing compares the two literals: `grep -rn BUS_SERVER test/` returns nothing, and `test/hooks.test.mjs:92` only asserts `assert.match(codex.hooks.PostToolUse[0].matcher, /promptobus_send/);` — it never touches `PROMPTOBUS_SERVER`. The only existing cross-check is external and one-directional: ati-agents' `cli/test/promptobus-host.test.mjs:91-92` compares ati-agents' own literal against the package's *compiled* `dist/hooks.js` value, protecting ati-agents from drifting away from `hooks.ts` — it does nothing for drift between `hooks.ts` and `contract.js` inside promptobus itself, and a standalone consumer of the published package (no ati-agents suite) has no protection at all.

No backlog or archive entry tracks this (grepped `docs/backlog` and `docs/archive` for `BUS_SERVER`/`PROMPTOBUS_SERVER`/`contract.js`/`hooks.ts` — no hits), and `contract.js`'s own header explains why harness-specific values were moved OUT of it but says nothing about `hooks.ts` keeping a second copy of the server name — the stale comment reads as an oversight, not a recorded decision.

## Work to do

- Move the server-name declaration to a new `src/contract.ts` (`export const PROMPTOBUS_SERVER = 'promptobus';`), and have `src/hooks.ts` import `BUS_SERVER` from it instead of declaring its own literal.
- Make `lib/contract.js` re-export the compiled value from `../dist/contract.js` instead of declaring its own literal, following the lib→dist pattern already used by `lib/host.js` and `lib/harness-home.js`.
- Fix the stale 'The package has no contract.js of its own' comment in `src/hooks.ts` to describe the corrected single source of truth.
- Add a test asserting `BUS_SERVER === PROMPTOBUS_SERVER` so a future edit to either cannot silently diverge inside the package.

## Out of scope

- ati-agents' `cli/test/promptobus-host.test.mjs` cross-check against `dist/hooks.js` — already correct, untouched by this entry.
- Renaming `PROMPTOBUS_SERVER`/`BUS_SERVER` or changing the bus server's actual name — this is a single-source-of-truth fix, not a rename.

## Verification

- After the change, `src/contract.ts` is the only module declaring the literal `'promptobus'` for the bus server; `lib/contract.js`'s `PROMPTOBUS_SERVER` and `src/hooks.ts`'s `BUS_SERVER` both trace to an import of it.
- The new equality test fails on a deliberately mismatched pair of literals (mutation probe) and passes on the merged code.
- `npm test` green.
