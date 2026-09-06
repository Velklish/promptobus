# PB-76 · Three doc claims describe a Cursor postToolUse bus hook with --output additional_context that the installer never writes, and hand-adding one would silently disable Cursor's real stop guard

- **Scope:** docs/guides/install.md, docs/guides/hooks-and-trust.md, lib/install.js, test/install.test.mjs
- **Created:** 2026-09-06
- **Dependencies:** none

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
