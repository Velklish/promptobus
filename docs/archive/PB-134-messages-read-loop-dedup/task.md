# PB-134 · The mailbox record-reading loop (parse, validate, isolate) is duplicated three times in messages.ts and has already drifted between copies

- **Order:** 310
- **Scope:** `src/v1/messages.ts`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

readInbox (src/v1/messages.ts:385-431) and peekInbox (:672-711) share a byte-identical block: the JSON.parse try/catch (411-416 / 690-695), the validate('message', parsed) branch and its note wording `does not match the schema: ${verdict.at} ${verdict.note}` (417-422 / 696-701), the schema-version-unsupported exemption ("a record from the future does not go to broken: it is not corrupt", 425-428 / 704-707), and the isolate(file, brokenInboxDir(...), name) call. They differ only in the readFileSync catch: readInbox rethrows anything but ENOENT with a neighbour-took-it comment (399-407), peekInbox swallows every error the same way (681-686). history (:536-552) repeats the parse-then-validate shape at a third site but never isolates — there is no isolate call in its loop, only broken.push(...) at 543 and 548 — and its note is worded without the "does not match the schema:" prefix: line 548 writes `note: \`${verdict.at} ${verdict.note}\``, versus the other two's fuller phrasing. So a malformed record read through promptobus_mailbox (or its peek) and the same record read through promptobus history report the note field in two different wordings today. No readRecord or equivalent helper exists — grep -rn readRecord src lib finds only an unrelated readRecordAt in lib/driver-cursor.js (a Cursor-driver function, different subsystem). Not tracked in docs/backlog or docs/archive (grepped for readInbox, peekInbox, messages.ts — no hits).

## Work to do

- Extract a single readRecord(file, name, attic: string | null): { message: MessageV1 } | { broken: BrokenNote } helper in src/v1/messages.ts, covering the read-then-parse-then-validate-then-isolate block currently repeated in readInbox and peekInbox, including the schema-version-unsupported exemption; attic = null skips isolation.
- Have readInbox and peekInbox call the helper, differing only in their readFileSync catch (rethrow non-ENOENT vs swallow everything) and in what they do with a successful read.
- Have history call the same helper with attic = null, so its BrokenNote.note reads identically to readInbox/peekInbox's ("does not match the schema: ...") instead of the shorter phrasing it produces today.
- Add a test that writes one malformed record and asserts BrokenNote.note is byte-identical whether read via readInbox, peekInbox or history.
- CHANGELOG.md entry noting history()'s BrokenNote.note wording is now consistent with promptobus_mailbox's.

## Out of scope

- Changing which of the three functions isolates a broken record: history stays the one that never moves the file — it reads only already-delivered history/ records, so there is nothing there to isolate.
- Any change to the schema-version-unsupported exemption's behavior or to isolate()'s own logic — this is a de-duplication and a wording-parity fix, not a policy change.

## Verification

- npm test — the existing suites touching readInbox, peekInbox and history (test/promptobus-history.test.mjs, test/v1-engine.test.mjs) stay green.
- New test: the same malformed record read through all three functions produces the same BrokenNote.note text.
- Mutation probe: reverting the extraction back to three separate inline blocks turns the wording-parity test red.

## Triage — 2026-09-07

- **Track:** X — Deferred structural work.
- **Priority:** P3.
- **Evidence level:** source/definition review at `1e0401a`, including `src/v1/messages.ts:385`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.

## Returned to the queue, 2026-09-12

**The return condition has fired:** blockers `PB-66` and `PB-146` are archived, so the resulting readers can be compared and genuinely identical behaviour extracted.

## Implementation notes — 2026-09-12

- `readRecord(file, name, attic)` owns the file read at `src/v1/messages.ts:306`, then the shared parse → validate → isolate block through `:330`. The callers retain only their policy catches: `readInbox` calls it at `:357` and skips `ENOENT` while recording other errno values at `:358-366`; `history` calls it at `:486` and turns a read failure into a `schema-invalid` broken note at `:487-490`; `peekInbox` calls it at `:659` and swallows every read error at `:660-663`. The `peek` catch-all is inherited from the previous implementation and remains outside this card's scope; its separate correctness question is tracked by PB-193.
- `glanceInbox` is not one of these three readers: it still performs its diagnostic raw read and JSON parse at `:686-702`, with its own `broken` policy.
- The malformed-record parity test writes the same bytes to inbox and history copies and compares the `BrokenNote.note` byte-for-byte across all three readers.
