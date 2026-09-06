# PB-76 · Three doc claims describe a Cursor postToolUse bus hook with --output additional_context that the installer never writes, and hand-adding one would silently disable Cursor's real stop guard

- **Order:** 950
- **Scope:** docs/guides/install.md, docs/guides/hooks-and-trust.md, lib/install.js, test/install.test.mjs
- **Created:** 2026-09-06
- **Dependencies:** PB-154

## Context

docs/guides/install.md:99 (table row) and docs/guides/hooks-and-trust.md:14 (table row) both claim Cursor's bus feedback is postToolUse with --output additional_context; docs/guides/hooks-and-trust.md:59 restates it as prose: Bus feedback arrives as additional_context because install passes --output additional_context. None of that is what the installer writes. cursorEvents (lib/install.js:206-208) returns { stop: [{ command: guardCmd }] } - the stop loop guard only. The SPECS.cursor entry (lib/install.js:224-235) keeps busEvent: 'postToolUse' with a comment saying why: busEvent is only for stripping a leftover bus group from an older install. Owned Cursor writes are stop alone. Bus feedback for this harness is driver injection. CURSOR_NOTE (lib/install.js:30) - 'Cursor: stop guard only. Bus feedback is driver injection, not a project hook.' - prints on every install that selects Cursor (lib/install.js:482). grep -rn additional_context over the whole repository hits only the three doc lines above and two negative test assertions - the flag exists nowhere in lib/ or src/. node --test test/install.test.mjs passes 14/14, including assertions that a Cursor install's hooks keys are exactly ['stop'] (line 291), that postToolUse is absent (lines 127, 292, 317), and that the written file text matches neither /additional_context/ nor /postToolUse/ (lines 297-298). It compounds: postToolUse is not in CURSOR_HOOK_EVENTS (lib/install.js:27 - ['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd', 'afterFileEdit']), and the comment directly above it (lines 25-26) says an unknown event name in .cursor/hooks.json silently disables every hook in the file. A reader who trusts the guide and hand-adds a postToolUse group to fix the missing bus hook would disable the stop loop guard along with it. The sample output is also incomplete: docs/guides/install.md:114-118 shows only TRUST_NOTE after The CLI prints configured and then:, but lib/install.js:482 prints CURSOR_NOTE too whenever Cursor is among the selected harnesses - confirmed by reading the branch (if selected includes codex or claude, info TRUST_NOTE; if selected includes cursor, info CURSOR_NOTE).

## Work to do

- docs/guides/install.md:99: change the Bus feedback cell to driver injection, not a project hook; keep Loop guard as stop.
- docs/guides/hooks-and-trust.md:14: change Owned records to stop running promptobus guard only.
- docs/guides/hooks-and-trust.md:59: drop the additional_context sentence; say bus feedback reaches a Cursor participant by driver injection, matching CURSOR_NOTE.
- While there, add a sentence that postToolUse is not a name Cursor recognises and that an unknown event name in .cursor/hooks.json silently disables every hook in the file, so a reader does not add one by hand.
- docs/guides/install.md:114-118: extend the sample post-install output to show CURSOR_NOTE alongside TRUST_NOTE, matching what lib/install.js:482 prints when Cursor is selected.

## Out of scope

- Any change to lib/install.js itself - the code is correct and already carries the note the docs should be quoting.
- The already-tracked Cursor availability entries (PB-7, PB-14.4, PB-16, PB-16.1, PB-27, PB-38) - none of them touch install-time hook documentation.

## Verification

- node --test test/install.test.mjs stays 14/14 green (docs-only change).
- Read docs/guides/install.md and docs/guides/hooks-and-trust.md side by side with lib/install.js:24-30, 206-235, 482: every Cursor claim matches what the code writes and prints.

## Consolidated evidence from PB-111

### PB-111 · The install and hooks-and-trust guides still promise a Cursor `postToolUse` bus hook with `--output additional_context` that the installer deliberately stopped writing, so a Cursor user debugging missing bus feedback is pointed at a mechanism that no longer exists

- **Scope:** `docs/guides/install.md`, `docs/guides/hooks-and-trust.md`, `lib/install.js`
- **Created:** 2026-09-06
- **Recorded dependencies:** none

### Context

Re-verified byte-for-byte against current HEAD. `docs/guides/install.md:99`: "| Cursor | `.cursor/hooks.json` (`version` 1) | `postToolUse` with `--output additional_context` | `stop` |". `docs/guides/hooks-and-trust.md:14` repeats it in its table; `hooks-and-trust.md:59` repeats it in prose: "Bus feedback arrives as `additional_context` because install passes `--output additional_context`."

Actual behavior: `lib/install.js:206-208` — `function cursorEvents(_busCmd, guardCmd) { return { stop: [{ command: guardCmd }] }; }` — the bus-command argument is discarded; only `stop` is ever written for Cursor. The adjacent comment at `lib/install.js:229-230` says so explicitly: "busEvent is only for stripping a leftover bus group from an older install. Owned Cursor writes are `stop` alone. Bus feedback for this harness is driver injection." `grep -rn additional_context` over `lib/`, `src/`, `templates/` returns nothing — the string occurs only in the three stale prose spots above. The corrected behavior is already tested and stable: `test/hooks.test.mjs:87` and `test/install.test.mjs:196` both assert the Cursor `postToolUse` group is absent/empty.

### Work to do

- Edit `docs/guides/install.md:99`'s Cursor row's "Bus feedback" cell to name driver injection instead of a `postToolUse` hook; keep `stop` in the "Loop guard" cell as-is
- Edit `docs/guides/hooks-and-trust.md:14` (table row) and `:59` (prose) the same way, matching `lib/install.js:229-230`'s own explanation
- Cite the existing regression test (`test/hooks.test.mjs:87` or `test/install.test.mjs:196`) from the corrected table/prose so the claim stays anchored to a running check — no new test needs writing

### Out of scope

- Writing a new test — the assertion that Cursor's owned hooks contain no `postToolUse` group already exists and passes
- The Claude and Codex rows of the same tables, which were checked against `lib/install.js:211-254` and are accurate

### Verification

- Neither `docs/guides/install.md`'s Cursor row nor `docs/guides/hooks-and-trust.md`'s Cursor row/prose mentions `postToolUse` or `additional_context`
- `grep -rn additional_context docs/guides/` returns nothing
- `test/hooks.test.mjs` and `test/install.test.mjs` still pass unchanged

## Triage — 2026-09-07

- **Track:** H — Hook installation and host commands.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/install.js:206`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
