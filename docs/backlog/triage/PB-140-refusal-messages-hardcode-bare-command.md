# PB-140 · Refusal messages hardcode literal `promptobus <verb>` (or a bare verb) instead of `host.busCommand(...)`, and the PB-1 gate only checks busCommand/formatCommand/formatNpx call sites

- **Scope:** [reference/03](../../reference/03-cli.md), `src/protocol.ts` (`claimRoute`), `test/cli.test.mjs`, the 11 `lib/*.js` files listed in Context
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`test/cli.test.mjs:99` is `const HEAD = /\b(?:busCommand|formatCommand|formatNpx)\(\s*\[\s*'([^']+)'/g;` — the PB-1 gate ("no message names a command the CLI does not have", closed by PB-1 and PB-1.1) only matches command names passed as literal array arguments to `busCommand`/`formatCommand`/`formatNpx` call sites. It never inspects a plain string literal.

But refusal text across the runtime writes the command name as a plain string instead of routing it through the host. Confirmed now, excluding comments and JSDoc: `lib/review.js:169,174,196`; `lib/dismiss.js:38,63`; `lib/done.js:173,324,326`; `lib/spawn.js:563,566,580`; `lib/store.js:483,489,850`; `lib/models.js:172,543`; `lib/driver-claude.js:367,429,768`; `lib/driver-codex.js:70,355,358,367`; `lib/driver-cursor.js:837,840`; `lib/codex-session.js:790` — 27 sites across 11 files (`grep -rn "promptobus [a-z]" lib/*.js`, comments excluded, gives the same count). For example `lib/review.js:169`: `+ '\`promptobus status\` lists the active ones, and \`promptobus done\` cleanup sweeps worktree directories of all closed tasks, '`.

Three of those sites (`lib/review.js:196`, `lib/dismiss.js:38`, `lib/done.js:326`) build the string by calling `claimRoute('promptobus review')` etc. — `claimRoute` is defined host-agnostically in `src/protocol.ts:190`: `export function claimRoute(repeat: string): string { return 'The task is yours, but this is a new session... repeat ${repeat}.'; }`. It renders whatever string the caller passes, untouched.

The correct pattern already exists nearby and is used correctly: `lib/done.js:388` — `` `Remove by hand: ${host.busCommand(['prune', '--yes'])}` `` — and `lib/status.js:74` — `` const lift = host.busCommand(['warden', `--task ${id}`]); ``.

Under the real consumer host (`ati-agents`, `node_modules/@agent-workspace/ati-agents/lib/promptobus/ati-host.js:23,260`): `const COMMAND = 'ati-agents'; ... busCommand: (args) => [COMMAND, 'promptobus', ...args].join(' ')` — so the runnable command is `ati-agents promptobus <verb>`, not `promptobus <verb>`. `which promptobus` in this workspace returns nothing (exit 1) — `promptobus` is not on `PATH`, so every one of the 27 literals is not just wrong prefix, it is unrunnable for a real user under the real host.

## Work to do

- At each of the 27 sites listed in Context, replace the literal `promptobus <verb>` (or, for the three `claimRoute(...)` calls, the bare-verb argument) with `host.busCommand(['<verb>', ...])`, using the pattern already correct at `lib/done.js:388` and `lib/status.js:74` — the host is already in scope in each of these functions.
- Extend `test/cli.test.mjs`'s PB-1 gate with a second check: scan non-comment string literals in `lib/*.js` for the pattern `promptobus <known-subcommand>` (reuse the existing subcommand set the gate already builds), and fail if a match is found outside a `busCommand`/`formatCommand`/`formatNpx` call argument. Skip lines that are comments (leading `//` or JSDoc `*`), the way this finding's own grep did.
- Update [reference/03-cli.md](../../reference/03-cli.md) if it documents any of the corrected messages verbatim.

## Out of scope

- Changing `claimRoute`'s own contract (it stays host-agnostic per ADR-002 and takes whatever already-formatted string the caller passes) — the fix is at each call site, not in `claimRoute` itself.
- Any refusal text that does not name a `promptobus` subcommand.

## Verification

- The extended `test/cli.test.mjs` gate goes red if run against the current tree (before the fix) and green after.
- `grep -rn "promptobus [a-z]" lib/*.js` (excluding comments) returns zero literal command mentions outside `busCommand`/`formatCommand`/`formatNpx` arguments.
- `npm test` stays green.
