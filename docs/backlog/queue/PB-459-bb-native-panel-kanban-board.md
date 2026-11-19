# PB-459 · Show active Promptobus runs as a kanban board in the BB native panel

- **Order:** 810
- **Scope:** [BB integration](../../reference/05-drivers.md)
- **Created:** 2026-11-19
- **Dependencies:** PB-429
- **Cost:** major

## Context

The owner's request of 2026-11-19: the native panel shows one selected task as a list of participants and messages, and the progress of a run is hard to read from it. The owner wants a board where pieces of work move across pipeline steps, where it is visible who works on what, and where a click leads to the piece's history and to the participant's current thread.

The CLI digest already derives the step each piece holds (`piecesOf` in `lib/digest.ts`). The panel has no equivalent, so the board would otherwise compute the same answer a second way.

Owner decisions of 2026-11-19: the board shows every active run as its own lane, finished runs collapsed; a click opens a side panel with the piece's history and an "Open thread" button.

## Work to do

- Move the piece-step derivation into `src/` as a pure function and use it from both the digest and the panel, so the CLI and the board agree on where a piece is.
- Add a read-only `board` projection to the native panel: active runs with their pieces, each with the holding step or done, the holder's harness, model, last status line, stall, unanswered question, unread count, thread id and session reference.
- Replace the panel page with a board: one lane per active run, columns for the pipeline steps plus Done, a card per piece, and a side panel with the piece's message history filtered by type. "Open thread" navigates to the participant's BB thread; a native participant without a BB thread shows its session reference instead.
- Keep the panel read-only, keep bounded owned reads, owner notifications and Diagnostics.
- Update the panel README, PLUGIN_OVERVIEW and CHANGELOG.

## Out of scope

- Any action on a run from the panel: moving cards, stopping actors, answering questions.
- A UI for the `promptobus` BB plugin.
- Publishing a plugin release or installing it.

## Verification

- Unit tests of the extracted function on fixtures: a piece at the worker step, under review, accepted by the approver, and at a step the panel does not know. The existing digest tests stay green.
- A projection test for `board`: several runs, limits, refusal of a path outside the owned store.
- `npx --no-install backslop gates` green with exit codes; `npm run probe` on the new tests.
- After an authorized release and installation: a live board on BB 0.50.1 with a real run, the side panel and thread navigation, with a screenshot; until then **notRun**.
