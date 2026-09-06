# PB-153 · `promptobus status` reports a Cursor participant's turn count from `turn.ended` — an end-of-file transcript marker its own parser says cannot count turns — instead of `record.turns`, the counter already in scope

- **Scope:** `lib/driver-cursor.js` (`inspect`, `registerWake`), `lib/cursor-persist.js` (`readTranscript`, `turnState`), `lib/status.js`, `test/promptobus-driver-cursor.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`inspect(ref)` in lib/driver-cursor.js reads `const record = readSession(ref)` at line 717, then — when the last turn is not busy — returns `note: \`the turn ended, turns in total ${turn.ended}${seen}\`` at line 820, where `turn` is `turnState(record)` (cursor-persist.js:717-735). `lib/status.js:265` prints that note verbatim: `session "${m.name}" is alive (${view.note ?? 'running'})`.

`turn.ended` is `readTranscript()`'s own `ended` counter (cursor-persist.js:672-705), and the function's own doc comment (cursor-persist.js:659-671) states plainly why it is the wrong number to show a person: `turn_ended` is not an event record but an end-of-file marker — after a second turn 'the former `turn_ended` vanishes from the middle, and a new one stands alone at the end … So it cannot count turns; the ended-turn counter is owned by the hook (`driver-cursor.js`, `registerWake`)'. That hook counter is `record.turns`: `registerWake` does `const turns = (Number(record.turns) || 0) + 1; patchSession(record.ref, { turns, ... })` (driver-cursor.js:566-567), and the record starts at `turns: 0` (driver-cursor.js:928). `inspect` already holds `record` — it read it at line 717, three lines into the function — so `record.turns` sits unused exactly where `turn.ended` is printed instead.

## Work to do

- In `inspect()` (driver-cursor.js:820), replace `turn.ended` with `record.turns ?? 0` in the note string. `record` is already in scope; no new read is needed.
- Add a case to `test/promptobus-driver-cursor.test.mjs` that patches a fixture record to `turns: 2` and asserts the printed note contains "turns in total 2", not the transcript's `ended` count.

## Out of scope

- Renaming or repurposing `turn.ended`/`readTranscript`'s `ended` field — it stays exactly what its comment documents, a parse-robustness artefact for 'is a turn running right now', and other code may keep reading it for that.
- Any change to `registerWake` or to how `record.turns` is incremented.

## Verification

- A two-turn Cursor session: `promptobus status` prints "turns in total 2", matching `record.turns` in the session file, not the transcript's end-of-file marker count.
