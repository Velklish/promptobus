# PB-58 · The preflight throws when the availability cache cannot be written, so a routed spawn dies with every verdict already in hand

- **Scope:** `lib/model-routing/preflight.js`, `lib/model-routing/cache.js`, `lib/driver-claude.js`, `lib/done.js`, `lib/util.js`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** none
- **Taken:** 2026-09-09

## Context

`lib/model-routing/preflight.js:395` — `if (Object.keys(probed).length) writeEntries(host, probed, { dryRun });` — is unguarded. `writeEntries` (`lib/model-routing/cache.js:543-558`) runs its body inside `withCacheLock` (lines 155-186), whose try/catch covers only taking the lock — the body itself runs as `try { return body(); } finally { … }` with no catch, so a `writeFileAtomic` failure at `cache.js:556` propagates. `writeFileAtomic` (`lib/util.js:107-127`) removes its temp file and rethrows (line 125). Nothing above the write catches it either: `routingContext` awaits `preflight` bare (`lib/models.js:226`), and is itself called bare from `lib/models.js:400`, `lib/models.js:923` and `lib/review.js:533`.

Reproduced now with a probe: `writeEntries` against a cache file inside a `0500` directory throws `EACCES: permission denied, open '.../.tmp-cache.json-<pid>-1'` even though every adapter had already answered successfully — the whole command dies on the write, not the probe.

The codebase already states the opposite rule twice, for the same kind of boundary on a neighbouring file: `lib/driver-claude.js:354-372`'s `markLimitAtStart` wraps its `markExhausted` call in try/catch with the comment "A cache failure does not replace the lift's own refusal… a write error on the way there would take that diagnosis with it"; `lib/done.js:289-296`'s `recordTelemetry` does the same for the sibling `telemetry.jsonl` file, warning instead of throwing. `docs/reference/03-cli.md` documents this exact boundary in its `limit-hit-at-start` description: "an unreadable routing path, a read-only directory… leaves through `fail()` with no code". The READ side of this same cache file is already tolerant — `test/model-routing-preflight.test.mjs:1004`, "a cache that cannot be read is the same as no cache" — but none of that file's 31 cases covers an unwritable cache directory.

`clearExhausted` (`lib/model-routing/cache.js:574`) writes the same file for a different reason: there the write IS the thing the person explicitly asked for (`--clear-exhausted`), so a failure there is a legitimate refusal and must stay one — the fix is scoped to the preflight's own call, not to `withCacheLock` generally.

## Work to do

- Wrap the `writeEntries(...)` call at `preflight.js:395` in a try/catch that warns (naming the file) and returns the snapshot anyway, matching the pattern already used by `markLimitAtStart` and `recordTelemetry`
- Add a case to `test/model-routing-preflight.test.mjs` beside the existing write tests: a cache directory with no write permission, and `preflight()` still returns the probed verdicts (with a warning, not a throw)
- Note the tolerance in `docs/reference/03-cli.md`'s existing availability-cache description, next to the read-side tolerance it already documents

## Out of scope

- `clearExhausted` (`cache.js:574`) — its write failure stays a refusal; no change there
- `withCacheLock` growing a blanket catch — the fix is local to the one call site in `preflight.js`

## Verification

- The new preflight test (0500/read-only cache directory) above
- `npm test`
- Manual: point a host's `routingPaths().cacheFile` at a file inside a directory with no write permission and call `preflight()` directly — it returns a snapshot and prints a warning, and does not throw

## Triage — 2026-09-07

- **Track:** R — Routing policy, overlays and availability.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/model-routing/preflight.js:395`, `lib/model-routing/cache.js:543`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
