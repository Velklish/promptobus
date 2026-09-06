# PB-106 · `calibrate --write`: the CLI reference promises a hand-set rating survives when the code replaces it, and a `user` overlay whose top-level JSON is not an object is rewritten with junk keys under `✔ merged`

- **Order:** 310
- **Scope:** [03-cli](../../reference/03-cli.md), [ADR-005](../../adr/adr-005-ten-point-scale-absolute-bands-calibrate.md), `lib/models.js`, `lib/model-routing/catalog.js`
- **Created:** 2026-09-06
- **Dependencies:** PB-91

## Context

Two separate gaps in the calibrate --write / strategy --set|--clear write path, both verified on HEAD (cc1aca8) with a probe built on the suite's own workspace() fixture (test/model-routing-calibrate.test.mjs).

Half 1 — the reference oversells what the code preserves. docs/reference/03-cli.md:100 says --write "merges only the proposed ratings ... keeping every other key of that file and every rating the person set by hand". The merge itself (lib/models.js:741-751) is per-tuple-and-per-rating:
```
const doc = readLayerFile(layer.path).data ?? {};
const ratings = { ...(doc.ratings ?? {}) };
for (const [tuple, block] of Object.entries(report.ratings)) {
  ratings[tuple] = { ...(ratings[tuple] ?? {}), ...block };
}
const next = { ...doc, schemaVersion: OVERLAY_SCHEMA_VERSION, ratings };
```
so a rating calibrate proposes on a tuple REPLACES the person's hand-set value on that same rating key. Probe: user overlay {"claude-sonnet-xhigh":{"quality":8,"speed":7}}, then calibrate --write --yes against the shipped telemetry fixture, which proposes speed 2→1 and quotaCost→4 for that tuple. Result on disk: {"quality":8,"speed":1,"quotaCost":4} — the hand-set speed: 7 is gone. This matches ADR-005 ("every other key and every UNPROPOSED rating in that file is preserved") and is the deliberate design — bands are compared against the shipped catalog on purpose — so the code is not the defect; the reference's "and every rating the person set by hand" clause is. The suite's own fixture (test/model-routing-calibrate.test.mjs:429-450) never catches this: it puts the hand-set quality exactly on the one rating calibrate does NOT propose for that tuple, and puts its other hand-set rating (speed: 4) on a different tuple entirely (codex-sol-max) that calibrate never touches.

Half 2 — a non-object overlay is silently mangled, not refused. readLayerFile (lib/model-routing/catalog.js:199-212) accepts any valid JSON value, not just an object. mergeRouting skips a present non-object layer without a word (catalog.js:592: `if (!layer?.present || !isObject(layer.data)) continue;`), so nothing on the read path refuses it either. Probed with a user overlay file holding [1,2,3], "hello", and 5 respectively, then running calibrate --write --yes: all three exit 0 and print "✔ merged 2 rating override(s) ... every other key of that file is unchanged". The file on disk afterward: [1,2,3] → {"0":1,"1":2,"2":3,"schemaVersion":2,"ratings":{...}}; "hello" → {"0":"h","1":"e","2":"l","3":"l","4":"o","schemaVersion":2,"ratings":{...}}; 5 → {"schemaVersion":2,"ratings":{...}} — the original value is gone entirely, with nothing on disk to say so. The same unguarded spread exists at lib/models.js:559 and :586 (models strategy --set/--clear), so the same corruption applies there too. This directly contradicts the principle the strategy path's own comment states (lib/models.js:570-573: "a broken layer above the writable one must refuse while the file on disk is still the one the person had") — it is a gap, not a documented choice. models validate still reports overlay-invalid on the resulting file afterward, so the person is left with both an invalid overlay and a mangled/lost original.

## Work to do

- Correct docs/reference/03-cli.md:100 to say what ADR-005 already says and the code already does: --write replaces a hand-set rating on a tuple/field it proposes, and keeps every other key and every rating it did NOT propose.
- Add an isObject guard before the write in calibrate --write (lib/models.js, around line 741) and in strategy --set/--clear (lib/models.js, around lines 559/586): when the layer file is present and its parsed JSON is not a plain object, refuse the way readLayerFile refuses invalid JSON — naming the path and what was found there — before any write happens.
- Two tests: (a) a hand-set rating on a tuple AND field calibrate also proposes, asserting the corrected documented outcome (the proposed value wins, the file's other keys survive); (b) a user overlay holding a non-object JSON value — the command refuses, and the file on disk is byte-for-byte the one the person had.

## Out of scope

- Full schema validation of the overlay's shape beyond "is it a plain object" — models validate already does deeper checking on an object-shaped overlay and is unaffected.
- The confirmation-prompt wording (listing which tuples/ratings a write is about to replace) — a genuine improvement, but a separate, larger UX change from the two bugs verified here.

## Verification

- node --test test/model-routing-calibrate.test.mjs — new tests (a) and (b) pass; existing 35 tests stay green.
- Reproduce probe (b) by hand: write [1,2,3] to the user overlay path, run models calibrate --write --yes — command exits non-zero, prints a refusal naming the path, and the overlay file's content is unchanged.
- docs/reference/03-cli.md:100 no longer promises a hand-set rating survives a proposal that touches it.

## Triage — 2026-09-07

- **Track:** T — Telemetry and calibration.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/models.js:741`, `test/model-routing-calibrate.test.mjs:429`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Refuse a present non-object writable overlay before rewriting it. Keep the ADR-defined overwrite behavior and correct only the contradictory description of hand-set fields.
