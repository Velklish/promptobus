# PB-77 · The telemetry end reading borrows entryLive, which holds an exhausted entry live until its reset, so a window delta can be measured against a days-old percentage the schema says must be null

- **Order:** 250
- **Scope:** [reference/03-cli](../../reference/03-cli.md) section Participant telemetry, lib/model-routing/telemetry.js (endReader), lib/model-routing/cache.js, schemas/model-routing/telemetry.schema.json, test/model-routing-telemetry.test.mjs
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

endReader (lib/model-routing/telemetry.js:127-133) gates the end-of-run window reading on entryLive: if (!entry || !entryLive(entry, at)) return () => null; (line 129). Its own docstring (lines 118-126) justifies this as the same entryLive the resolver decides on, so a delta measured against an hour-old percentage is not a delta. But entryLive (lib/model-routing/cache.js:507-509) defers to entryExpiry (lines 490-503), which short-circuits before any TTL for an exhausted entry: if (entry.state === 'exhausted') return entry.resetAt ? Date.parse(entry.resetAt) : Infinity;. For routing that answer is right - an exhaustion is held by its own reset, not a TTL - but it is the wrong rule for a freshness question. Reproduced live against the current tree by calling the real entryLive/entryExpiry with an entry checkedAt 3 days ago holding one window at usedPercent 97: an available entry gives entryLive false and usedPercentAtEnd null; an exhausted entry with resetAt 3 days ahead gives entryLive true and usedPercentAtEnd 97; a sticky exhausted entry with resetAt null gives entryLive true (expiry Infinity) and usedPercentAtEnd 97. The same three-day-old percentage is refused as stale in one state and handed back as a measurement in the other. All three adapters carry windows on their exhausted branch (lib/model-routing/adapter-claude.js:698, adapter-cursor.js:835, adapter-codex.js:429), so those frozen readings are exactly what endReader returns once an entry goes exhausted. Two written contracts say the opposite of what the code does: schemas/model-routing/telemetry.schema.json:104 states usedPercentAtEnd is null when the entry may not still be used, because a delta measured against a stale percentage is not a delta; docs/reference/03-cli.md:651 says past the TTL it is null for the same reason. The reader is shipped and consumed: lib/model-routing/calibrate.js computes a run's spend as usedPercentAtEnd minus usedPercentAtSpawn, and the quotaCost proposals from models calibrate (shipped in v0.5.0) rest on nothing else. --refresh does not save the sticky case: heldOf (cache.js:522-529) deliberately keeps a sticky exhaustion (stickyExhaustion, lines 479-481) even under --refresh, so only --clear-exhausted ever replaces that entry - the frozen percentage can persist indefinitely. No test covers it: grep -n exhausted test/model-routing-telemetry.test.mjs returns nothing, and the one stale-cache test present (lines 287-318) seeds only an available entry two hours old. Not a defect in entryLive or in the exhaustion rule - both are correct for routing. The defect is one predicate answering two different questions: may routing still use this entry, and is this percentage fresh enough to compute a delta from.

## Work to do

- Give the telemetry reader its own freshness predicate instead of reusing the routing one - e.g. Date.parse(entry.checkedAt) + WINDOW_TTL_MS > at for an entry carrying windows, with no exhaustion short-circuit - the rule the docstring and the schema already promise.
- Correct the docstring at lib/model-routing/telemetry.js:118-126: explain why the routing predicate is the wrong one for this question (an exhaustion stays live for routing until its reset; that is not the same as being fresh), rather than claiming the two share one definition.
- Add the missing cases to the stale-cache section of test/model-routing-telemetry.test.mjs: an exhausted, non-sticky entry past the window TTL with a future resetAt, and a sticky one with resetAt null - both must give usedPercentAtEnd null.
- If the decision instead is that a frozen exhausted reading is worth keeping as evidence, rewrite the schema description and docs/reference/03-cli.md section Participant telemetry to say so explicitly, and give calibrate a way to tell a measured percentage from a frozen one - the current text promises one thing and the code holds another.

## Out of scope

- PB-37.2's question - whether done should probe the cache fresh before writing a record - is the opposite failure (losing the number entirely) and stays deferred separately; this entry does not touch done or add a probe, only the freshness predicate endReader already applies to data already sitting in the cache.
- Any change to entryExpiry, entryLive, or the sticky-exhaustion rule in heldOf - all three are correct for the routing decision they serve.

## Verification

- New tests in test/model-routing-telemetry.test.mjs: an exhausted, non-sticky entry past its window TTL, and a sticky exhausted entry, both give usedPercentAtEnd null through the real telemetry-writing path.
- node --test test/model-routing-telemetry.test.mjs green, including the existing available-entry stale case.

## Triage — 2026-09-07

- **Track:** T — Telemetry and calibration.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/model-routing/telemetry.js:127`, `lib/model-routing/cache.js:507`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
