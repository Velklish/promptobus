# PB-103 · The Stop/SessionStart guard hook hardcodes the word "promptobus" in its argv, so it silently demands that every consumer's bin accept that word, a host with another `commandName` gets a loop guard its own dispatcher refuses

- **Scope:** `src/hooks.ts` (`guardHookCommand`), `src/host.ts` (`busArgv`), `src/standalone.ts` (`busArgv`), `lib/install.js`, `lib/cli.js`, [reference/02-host.md](../../reference/02-host.md) section What the host must answer
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`src/hooks.ts:75` builds the installed guard command as a literal:

```ts
return `"${host.nodePath()}" "${host.layoutBinPath()}" promptobus guard${flags}`;
```

It reaches `.claude/settings.json`, `.cursor/hooks.json` and `.codex/hooks.json` through `lib/install.js:317` (`planHookInstall`), and participant settings through `lib/spawn.js:793` and `lib/review.js:447`. The dispatcher drops that leading word only when it equals the host's own name: `lib/cli.js:160` - `if (args[0] === host.commandName) args.shift();`. `commandName` is host-declared, defaulted from `promptobus.json` (`src/standalone.ts:132`) and documented as an optional key of that file (`README.md:56`, `docs/reference/02-host.md:29`).

Verified now: with `promptobus.json` `{"commandName":"bus"}` and a standalone host, `guardHookCommand` produced `".../node" "/fake/bus.js" promptobus guard`, and running `['promptobus','guard']` through `runPromptobus` with that host printed `unknown command "promptobus" - spawn, review, models, ...`. Both shipped hosts survive only by spelling coincidence: `bin/promptobus.js:29` forces `commandName: 'promptobus'` so the word is shifted off, and the ATI host routes the bus under a subcommand literally named `promptobus` (`ati-host.js:264`, `busArgv: (args) => [binPath, 'promptobus', ...args]`, `COMMAND = 'ati-agents'`). The requirement this places on a consumer - "your bin must accept the bare word promptobus at argv[0]" - appears in no reference file.

The failure is silent: `lib/guard.js:245-247` states the harness contract - only exit 2 blocks a turn, any other non-zero is a warning that does not return it - so a broken guard is a loop guard that is simply off, with nothing in `status`, the warden journal or the tape naming the cause.

The seam this needs already exists and is one field short: `busArgv` (`src/host.ts:299`, `src/standalone.ts:309`) answers `['<bin>', 'guard']` standalone and `['<bin>', 'promptobus', 'guard']` for the ATI host, but it names `binPath()` where the hook needs `layoutBinPath()`.

## Work to do

- Give the host a layout-bin variant of the existing seam - either a `guardArgv(args)` member beside `busArgv`, or a variant of `busArgv` itself - that answers the same subcommand path against `layoutBinPath()` instead of `binPath()`, and let `guardHookCommand` (`src/hooks.ts:75`) quote whatever it gets instead of spelling the word.
- Implement it on both hosts: standalone answers `[layoutBin, 'guard', ...]`, ATI answers `[layoutBin, 'promptobus', 'guard', ...]` - so the installed command is unchanged for every shipped configuration.
- Document the new member in `docs/reference/02-host.md` section What the host must answer, next to `layoutBinPath()`.
- Add a test that installs under a non-default `commandName` and runs the produced guard argv through `runPromptobus`, so the fix is exercised rather than string-matched.

## Out of scope

- Changing `commandName` itself or its defaulting - this entry only stops the guard hook from assuming it equals the literal word "promptobus".
- Any change to the existing `busArgv` call sites for `mcp`/`warden` - those already go through the host correctly; only the guard hook has its own hardcoded literal.

## Verification

- Existing assertions stay green unchanged: `test/promptobus-guard.test.mjs:460`, `test/install.test.mjs:123-194`, `test/promptobus-driver-cursor.test.mjs:274`.
- New test: install with `commandName: 'bus'`, run the produced guard command through `runPromptobus` - it dispatches to `guard`, not "unknown command".
- `npm test`.
