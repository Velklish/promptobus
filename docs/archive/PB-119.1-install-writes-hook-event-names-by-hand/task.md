# PB-119.1 · `lib/install.js` writes the hook event names as literals while importing the matcher from `dist`, so `GUARD_HOOK_EVENT` still has an untied third door

- **Scope:** `lib/install.js`, `src/hooks.ts`, `test/promptobus-package.test.mjs`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-07
- **Dependencies:** PB-119
- **Taken:** 2026-09-10

## Context

PB-119 tied two declarations of the Claude guard event together: `GUARD_HOOK_EVENT` in `src/hooks.ts` and the redeclaration that used to sit in `lib/driver-claude.js`, which now imports it. A third declaration was outside that task's scope and remains untied.

`lib/install.js` — the module that generates and cleans harness hook settings, which is exactly what the guarantee is about — writes the event names as literals:

- `claudeEvents` builds the settings object with `PostToolUse`, `Stop` and `SessionStart` spelled out (`:199-203`);
- `SPECS.claude` declares `busEvent: 'PostToolUse'` and `guardEvents: ['Stop', 'SessionStart']` (`:214-215`);
- `SPECS.codex` repeats the same pair (`:246-247`).

The import route is already open in that file and used for the neighbouring value: `matcher: BUS_HOOK_MATCHER` (`:216`, `:233`) comes from `../dist/hooks.js` (`:14-18`). Only the event names are hand-written.

The failure this permits is the one PB-128 described for the server name, and it is silent: rename `GUARD_HOOK_EVENT` and a participant's settings file follows the new name while `install` and `check` keep writing and removing `Stop`. The installed guard stops matching what the mechanism believes it installed, and the suite stays green — `grep -rn "guardEvents\|claudeEvents" test/` finds no check tying these literals to the compiled declaration.

Found during the acceptance of PB-119 on 2026-09-07 and verified by reading `lib/install.js` at `b798074`. PB-119's own reference sentence claimed the event "has one declaration" and that "the two doors cannot rename the event independently"; that claim was corrected in the same pass to name only the two doors PB-119 actually tied.

## Work to do

- Take the event names in `lib/install.js` from the compiled declaration the same way `BUS_HOOK_MATCHER` already is, rather than from literals — `GUARD_HOOK_EVENT` for the guard door, and whatever name the bus door needs, declared once beside it.
- `SessionStart` has no declaration anywhere today. Decide whether it becomes one beside `GUARD_HOOK_EVENT` or stays a literal with the reason written down; do not leave it undecided.
- Add a check that fails when a name in the generated settings diverges from the compiled declaration, in the shape `test/promptobus-package.test.mjs` already uses for the server name.
- Extend the `03-cli.md` sentence once the third door is tied, so it can say what it originally tried to say.

## Out of scope

- The values themselves — `Stop`, `SessionStart` and `PostToolUse` keep their names; this ties the declarations together.
- The Cursor spec's own event vocabulary (`cursorEvents`, `stop`) — a different harness with a different spelling, and no claim in the reference covers it.

## Verification

- Renaming `GUARD_HOOK_EVENT` in `src/hooks.ts` alone makes the suite red, naming the generated settings; today it stays green.
- `grep -n "'Stop'" lib/install.js` returns nothing, or returns only a declaration whose reason is written beside it.
- An installed settings file is byte-identical to the one produced before the change.
- `npm test` stays green.

## Triage — 2026-09-07

- **Track:** H — Hook installation and host commands (`lib/install.js`, `src/hooks.ts`).
- **Priority:** P2. Nothing is broken today — both sides read `Stop`; a rename would break the installed guard silently, and the suite would stay green.
- **Evidence level:** source review at `b798074` during PB-119's acceptance: the literals at `lib/install.js:199-203`, `:214-215`, `:246-247` against the `dist/hooks.js` import in the same file.
- **Next step:** implement as written. `SessionStart` has no declaration anywhere — decide whether it gains one or stays a literal with the reason recorded; do not leave it undecided.
