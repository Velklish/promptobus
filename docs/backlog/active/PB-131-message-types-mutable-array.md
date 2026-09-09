# PB-131 · MESSAGE_TYPES is exported as a plain mutable array that MESSAGE_TYPES_V1 aliases rather than copies, so a push from any consumer changes what both validation gates accept for the rest of the process

- **Scope:** [reference/04-protocol](../../reference/04-protocol.md), `src/protocol.ts`, `src/v1/model.ts`
- **Created:** 2026-09-06
- **Dependencies:** PB-132
- **Taken:** 2026-09-09

## Context

`src/protocol.ts:18` — `export const MESSAGE_TYPES = ['task', 'status', 'question', 'answer', 'artifact', 'result', 'review'];` — no `as const`, no `Object.freeze`. `src/v1/model.ts:122` aliases the same array object rather than copying it: `export const MESSAGE_TYPES_V1: readonly string[] = MESSAGE_TYPES;` (`readonly string[]` is a TypeScript-only annotation; it does not freeze or copy anything at runtime). Both validation gates read the alias — `src/v1/validate.ts:189` and `src/v1/engine.ts:229-230` — and the legacy store reads the original directly (`src/legacy-store.ts:541-542`). Re-ran the mutation probe against the built `dist/index.js` and `dist/v1/index.js` just now: `same object: true`, `frozen: false`; after `MESSAGE_TYPES.push('injected')`, `MESSAGE_TYPES_V1.includes('injected')` is `true` and the length goes 7 → 8. `docs/reference/04-protocol.md:17` documents the seven values as the message-type contract, with no mention that the list is mutable. The neighbouring constants of the same kind already use the frozen-tuple idiom — `MODELS` (`src/v1/model.ts:16`, `= [...] as const;`) and `ERROR_CODES` (`src/v1/errors.ts`, ends `] as const;`) — so `MESSAGE_TYPES` is the one exported enumeration of this kind that skipped the pattern. No test or in-repo consumer mutates it today; `test/mcp.test.mjs:142` defensively spreads `[...MESSAGE_TYPES]` before reusing it in a schema, which reads as the mutability already being felt as a hazard.

## Work to do

- Freeze MESSAGE_TYPES at runtime and give it a readonly TypeScript type; `as const` alone does not prevent a JavaScript caller from mutating the array.
- Let `src/v1/model.ts:122`'s `MESSAGE_TYPES_V1` be `MESSAGE_TYPES` directly rather than a separately re-annotated alias, now that the source is a readonly tuple.
- Check the one place that assigns from it into a mutable-typed field — `test/mcp.test.mjs:142`'s `enum: [...MESSAGE_TYPES]` — still type-checks (it already copies into a plain array, so this should be a no-op).

## Out of scope

- No behavior change for any caller that only reads the list — this is a compile-time and runtime-immutability fix, not a change to what types are accepted.
- `ERROR_CODES` and `MODELS` are already frozen and are not touched.

## Verification

- `npm test` and `npm run build` stay green.
- Re-run the mutation probe: `node -e "const a=require('./dist/index.js'); try { a.MESSAGE_TYPES.push('x'); console.log('mutated:', a.MESSAGE_TYPES.length); } catch(e) { console.log('threw:', e.constructor.name); }"` — must throw or leave the length at 7, not silently reach 8.

## Triage — 2026-09-07

- **Track:** S — Store integrity and public engine.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `src/protocol.ts:18`, `src/v1/model.ts:122`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** as const is compile-time only and disappears from emitted JavaScript. Use runtime immutability (for example Object.freeze with a readonly type) and a JavaScript consumer mutation regression covering both validators. A type-only edit does not meet acceptance.
