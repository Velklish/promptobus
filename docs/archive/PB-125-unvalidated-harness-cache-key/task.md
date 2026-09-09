# PB-125 · writeEntries keys the availability cache by a raw harness string with no HARNESS_RE check, so a workspace declaring a name the schema rejects writes a snapshot document that fails it

- **Scope:** [reference/03-cli](../../reference/03-cli.md) § Model routing → Availability, `lib/model-routing/cache.js`, `lib/model-routing/preflight.js`, `lib/model-routing/validate.js`, `schemas/model-routing/snapshot.schema.json`, `src/standalone.ts`
- **Created:** 2026-09-06
- **Dependencies:** none
- **Taken:** 2026-09-09

## Context

Reproduced live against current HEAD (v0.5.0) with the real module and a real ajv 2020 validator against `schemas/model-routing/snapshot.schema.json`. `writeEntries` (`lib/model-routing/cache.js:551`) does `for (const [harness, entry] of Object.entries(entries)) harnesses[harness] = snapshotEntry(entry);` — the value is projected field by field, the key is copied verbatim. `snapshot.schema.json:21` closes the `harnesses` object with `"propertyNames": { "pattern": "^[a-z][a-z0-9-]{0,31}$" }`. Calling `writeEntries(host, { Claude_Code: <valid entry> })` wrote `harnesses: { Claude_Code: {...} }` to disk, and ajv answered `false` with a `propertyNames`/`pattern` error on `Claude_Code`.

The path is reachable end to end: `src/standalone.ts:139` — `const tools = Array.isArray(config.tools) ? config.tools.map(String) : [];` — takes `promptobus.json`'s `tools` array completely unvalidated and exposes it as `declaredTools()` (`:198`); `preflight()` (`lib/model-routing/preflight.js:338`) consumes that list (its own comment at `:203-204` says "the names reaching it come from `host.declaredTools()` — a workspace declaration nothing here validated"); `adaptersOf` (`:216-234`) does not drop an unmapped name — it catches the throw from `adapterFor` and turns it into a normal `broken[harness] = noAdapterVerdict(...)` verdict; `broken` merges into `answers` (`:379`) and is written via `writeEntries` (`:395`). `HARNESS_RE` (`^[a-z][a-z0-9-]{0,31}$`, `lib/model-routing/validate.js:35`) exists but is private (not exported) and applied only to catalog tuples (`:172-174`) and overlay `account` keys (`:457`) — never at this boundary.

One caveat the raw finding did not carry: `readSnapshot` (`cache.js:435-444`) does NOT run the JSON Schema on read — it only checks `harnesses` is an object and `schemaVersion` matches — so a malformed key round-trips through every path that exists today with no visible malfunction. The invariant is stated (`cache.js`'s own header calls this file "the disk boundary of routing") but held by nothing; the failure is dormant until a future schema-validating reader, a migration, or a shared-fixture/contract test is added. Not already tracked: grepped `docs/backlog` and `docs/archive` for harness/propertyNames/writeEntries/declaredTools — the closest neighbours (PB-21's `harness-unknown` code, `03-cli.md`'s `--harness` validation) cover the CLI flag and catalog/overlay shapes, not `declaredTools()` → cache-key.

## Work to do

- Export `HARNESS_RE` from `lib/model-routing/validate.js` (currently a private `const`).
- Apply it at the point a harness name enters the file: either in `writeEntries` (`cache.js:551`, drop or refuse a key that does not match before assigning `harnesses[harness]`) or upstream in `preflight.js` where the probed-harness list is built — reuse the one exported constant rather than adding a fourth copy of the regex literal.
- Add a test to `test/model-routing-preflight.test.mjs` (or a cache-focused test file) writing an entry keyed by an invalid harness name and asserting it is dropped/refused rather than written.
- CHANGELOG entry under `[Unreleased]`: `writeEntries` now refuses/drops a harness name that fails `HARNESS_RE` instead of writing it — a behaviour change, even though nothing in this build reads the cache with schema validation today.

## Out of scope

- Making `readSnapshot` validate the cache against the JSON Schema on read — a separate, larger question about whether the cache is ever schema-checked after being written.
- Rejecting the malformed name earlier, at `declaredTools()`/`promptobus.json` parsing — this entry closes the gap at the point nearest the stated invariant (the cache boundary), not every upstream place a bad name could be caught.

## Verification

- New test: `writeEntries(host, { Claude_Code: <valid entry> })` (or any name failing `HARNESS_RE`) results in no such key in the written document, or the call refuses.
- Validating a freshly written cache file against `schemas/model-routing/snapshot.schema.json` with ajv passes for every harness name `writeEntries` accepted.

## Triage — 2026-09-07

- **Track:** R — Routing policy, overlays and availability.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/model-routing/cache.js:551`, `src/standalone.ts:139`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
