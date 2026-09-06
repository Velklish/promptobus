# PB-102 · The mixed-version diagnosis is wired to nothing: `bus()` memoises the engine before the reader version arrives, the orchestrator record is stamped `0.0.0`, and a prerelease tail falls back to "journal does not match the schema"

- **Order:** 450
- **Scope:** `lib/store.js` (`bus`, `createTask`, `claimOwnership`), `lib/warden.js`, `src/v1/store.ts` (`cmpVersion`, `writtenByNewer`), [reference/04-protocol.md](../../reference/04-protocol.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-65, PB-146

## Context

Three defects, each verified now against this tree through `lib/store.js` (the mechanism door), not just against the core engine.

1. The reader version never reaches the engine. `lib/store.js:205-213` keys the `engines` memo by `home` alone and returns a cache hit before looking at `cli`, so the `cli ?? '0.0.0'` placeholder wins on every hit:

```js
export function bus(home, { cli } = {}) {
  const hit = engines.get(home);
  if (hit) return hit;
  const engine = openEngine({ home, policy: atiRouting, cli: cli ?? '0.0.0' });
```

`grep -rn "bus(.*cli" lib bin` finds exactly two call sites that pass `cli`: `lib/store.js:205` and `lib/warden.js:203`. `lib/warden.js:201` calls `resolveTaskId(home, ...)` one line before `bus(home, { cli })` at `:203`; `resolveTaskId` -> `taskExists` -> `lib/store.js:321` `bus(home).taskExists(id)`, with no `cli` - memoising the engine with the placeholder first. Verified: after `taskExists(home, 'nope')`, `bus(home, { cli: '9.9.9' }) === bus(home)` is `true`. The comment at `lib/store.js:208-209` ("both paths, the CLI command and the bus MCP server, go through this door") holds for neither.

2. The orchestrator record is stamped with the placeholder. `lib/store.js:264` writes `mechanismVersion: fields[MECHANISM_VERSION_FIELD] ?? '0.0.0'`. The two orchestrator writers pass no version - `createTask` (`lib/store.js:427`) and `claimOwnership` (`lib/store.js:689`) - while lifts do: `lib/spawn.js:1291` and `lib/review.js:709` both pass `plan.host.version`. Verified: `createTask(home, { id, owner: 'sess-1' })` writes `participants[0].metadata.mechanismVersion === "0.0.0"`; adding one unknown field to that record and reading it gives `task ... journal does not match the schema: participants[0] extra fields: brandNewField` - `writtenByNewer` (`src/v1/store.ts:82-96`) narrows to `verdict.at`'s index and `cmpVersion('0.0.0', reader) !== 1` drops the candidate. Stamping the same record `0.6.0` instead flips the same read to `participant orchestrator was written by mechanism 0.6.0, this session runs 0.0.0, start a new session`. A task with no lift yet has no other record to rescue the diagnosis, so an unknown field on the orchestrator record fails outright rather than naming a version.

3. A prerelease tail disarms the compare. `src/v1/store.ts:56-59` maps every dot-segment through `Number` under an `Number.isInteger` guard, so `cmpVersion('0.6.0-rc1', reader)` returns `null` and the candidate is skipped. Verified with the same fixture and a prerelease writer version. No shipped release has ever carried such a tag (tags v0.1.0 through v0.5.0 are plain semver), so this leg is prerelease-testing exposure rather than a live path.

Why it stayed invisible: `test/v1-engine.test.mjs:1107-1180` covers the branch thoroughly but opens the engine directly with an explicit `cli`, bypassing `lib/store.js` entirely; `grep -rn "mechanismVersion" test/` finds no adapter-level test.

## Work to do

- `lib/store.js` `bus()`: key `engines` by `home` + `cli` (or, on a hit whose engine still holds the placeholder, reopen with the named version).
- Open with the real version at the first store touch of every entry point: move `bus(home, { cli: host.version })` in `lib/warden.js` above `resolveTaskId`, and check the CLI dispatch and MCP server paths do the same. Once every entry point names a version, drop the `'0.0.0'` default so an unversioned open becomes a programming error instead of a silent wrong answer.
- Thread `host.version` into the two orchestrator writers - `createTask` (`lib/store.js:427`) and `claimOwnership` (`lib/store.js:689`) - passing it as `participantRecord(ORCHESTRATOR, { owner, mechanismVersion: version })`, the way `lib/spawn.js:1291` already does for lifts.
- `src/v1/store.ts` `cmpVersion`: cut the string at the first `-` or `+` before splitting, so a prerelease or build tail compares on its numeric core instead of returning `null`.
- Update docs/reference/04-protocol.md if it documents the mixed-version diagnosis, to match the corrected behaviour.

## Out of scope

- Any change to the diagnosis's message wording beyond making it accurate - this is a plumbing fix, not a UX rewrite.
- Retroactively re-stamping existing on-disk orchestrator records - the fix only changes what new writes carry.

## Verification

- Adapter-level test that goes through `lib/store.js` (not the raw engine): create a task, add an unknown field to `participants[0]`, read with a named host version, and assert `schema-version-unsupported` naming the real release on both sides - for a plain-semver and a prerelease writer version.
- `npm test`.

## Triage — 2026-09-07

- **Track:** S — Store integrity and public engine.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/store.js:205`, `lib/warden.js:203`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
