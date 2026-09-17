# PB-230 · The Cursor hook-event list knows 5 names of 21: an unknown event name silently drops the whole hooks.json

- **Scope:** `lib/driver-cursor.js` (`KNOWN_HOOK_EVENTS`), `lib/install.js` (`CURSOR_HOOK_EVENTS`), `test/promptobus-driver-cursor.test.mjs`, `test/install.test.mjs`, [03-cli](../../reference/03-cli.md) § Cursor hooks
- **Created:** 2026-09-17, consumer run
- **Dependencies:** none
- **Taken:** 2026-09-17

## Context

`KNOWN_HOOK_EVENTS` in `lib/driver-cursor.js` names five events — `sessionStart`, `beforeSubmitPrompt`, `stop`, `sessionEnd`, `afterFileEdit` — and `lib/install.js` carries the same five under `CURSOR_HOOK_EVENTS`, with `test/install.test.mjs` asserting the two lists are equal and `test/promptobus-driver-cursor.test.mjs` asserting `length === 5`. The five come from the live spike that proved them firing; they say "these work", not "there are no others".

The inventory of the installed binary says otherwise. Read from `cursor-agent` 2026.09.10-fd3934a (`~/.local/share/cursor-agent/versions/2026.09.10-fd3934a`, the `_E` table in the `index.js` bundle) on 2026-09-17, without a live session: twenty-one names —

`beforeShellExecution`, `beforeMCPExecution`, `afterShellExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeTabFileRead`, `afterTabFileEdit`, `stop`, `beforeSubmitPrompt`, `afterAgentResponse`, `afterAgentThought`, `sessionStart`, `sessionEnd`, `preCompact`, `subagentStart`, `subagentStop`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `workspaceOpen`.

One of the sixteen missing names is already in use outside this package: a consumer's memory-hook installer hangs a tracker on `afterMCPExecution`, measured firing on 2026-08-24. The gate today only narrows what the driver may write, and the driver writes one event, so the cost is zero — until a driver or an installer needs an event outside the five and the refusal reads as "Cursor cannot do that". The refusal is loud in the package and silent in the harness: an unknown name in `.cursor/hooks.json` disables every hook in the file.

## Work to do

- Decide the source of the list and write it down beside it: the bundle inventory (exact, but bound to a binary version) or the live spike (proven firing, but incomplete by design). The recommendation is the bundle inventory with the version it was read from, kept beside `PROVEN_CURSOR_VERSION`, and the spike's five marked as the ones proven live.
- Extend the list to the twenty-one names, remove the second copy in `lib/install.js` or keep it under the existing equality assertion, and replace the `length === 5` assertion with one that reads the list.
- An unknown name must still be refused before the file is written: that is the guard the list exists for.
- Say in [03-cli](../../reference/03-cli.md) which names are proven live and which are inventory only.

## Out of scope

- Wiring any new event into a hook: no consumer asks for one in this card.
- Whether the sixteen inventory-only events fire in `agent -p` or in the IDE: not measured, and a live Cursor session is not part of this card.

## Verification

- `KNOWN_HOOK_EVENTS.length === 21`, the five proven names are a subset, and the source version is recorded beside the list.
- The install and driver suites pass; a mutation probe that drops one inventory name from the list turns a verdict red.
- A `.cursor/hooks.json` with an unknown event name is still refused before the write, with the name in the refusal.
