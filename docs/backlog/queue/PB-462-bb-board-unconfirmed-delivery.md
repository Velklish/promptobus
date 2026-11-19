# PB-462 · Mark a BB board step that rests on an unfinished delivery

- **Order:** 840
- **Scope:** [BB native panel](../../../integrations/bb-native-observer/README.md#board)
- **Created:** 2026-11-19
- **Dependencies:** none
- **Cost:** minor

## Context

The board places a piece by the messages it finds through `history/` and `inbox/` links (`taskMessages` in `integrations/bb-native-observer/projection.ts`). A send writes the message to `messages/`, then hard-links it into those directories; while that fan-out is unfinished its intent stays in `tasks/<id>/intents/<message>.json`. When the file system keeps refusing the link (`link-refused`, `test/v1-races.test.mjs` "the FS refused a hard link"), the intent persists until a recovery succeeds. Every board poll meanwhile shows the piece on its earlier step as if nothing were pending, and nothing on the card says a delivery is unfinished. Found in the PB-459 review; the owner chose to file it rather than widen PB-459.

## Work to do

- Read the open intents of a sampled run within the board's existing read boundary (`ownedText`, count and size limits), without opening the engine or recovering the fan-out.
- Mark a piece with an open intent from or to its participants as having an unfinished delivery, on the card and in the side panel.

## Out of scope

- Recovering or retrying the fan-out from the panel: the panel stays read-only.

## Verification

- A fixture run with a refused inbox link shows the affected piece with an unfinished delivery, and the same run after a successful recovery shows it on its next step without the mark.
- A run whose intents directory leaves the owned store refuses that lane like a foreign history entry does.
