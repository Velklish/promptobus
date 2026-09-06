# PB-80 · The CLI's top-level catch decides whether to hide a stack by comparing `constructor.name` strings against four classes, one of which — `ResolveError` — belongs to no class in this package

- **Order:** 1010
- **Scope:** `lib/cli.js`, `test/cli.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`lib/cli.js:369-377`:
```
    const expected = e?.status !== undefined
      || e?.constructor?.name === 'ResolveError'
      || e?.constructor?.name === 'GateError'
      // A routing refusal is a `PromptobusError` with one of the codes the
      // reference tables: the message is the whole diagnosis — for a run with no
      // candidate it carries the rendered decision — and a stack under it would
      // bury the part a person reads.
      || e?.constructor?.name === 'PromptobusError'
      || e?.constructor?.name === 'HostResolveError';
```
decides whether an error is "expected" (message only, no stack) by matching `e?.constructor?.name` as a plain string against four literals. Three of the four name real classes defined and exported by this package: `GateError` (`src/protocol.ts:49`, exported via `src/index.ts:31`), `PromptobusError` (`src/v1/errors.ts:67`, exported via `src/index.ts:31`), and `HostResolveError` (`src/host.ts:27`, exported via `src/index.ts:96`). All three are already imported and used with `instanceof` elsewhere in this same package — `lib/models.js:24` and `lib/harness-home.js:35` (`import { GateError } from '../dist/index.js'`, then `if (!(e instanceof GateError))` at `lib/models.js:160`), `lib/liftoff.js:1` (`import { PromptobusError } from '../dist/index.js'`), and `lib/host.js:9` (`import { ... HostResolveError ... } from '../dist/host.js'`) — so `instanceof` is available here at zero new-import cost.

`ResolveError` names nothing in this package: `grep -rn "class ResolveError" src lib dist` returns no hits. It is a class in the consumer repository consumer-cli (its own `cli/lib/resolve.js`), and that repository's own host adapter already converts any `ResolveError` it might throw into a `HostResolveError` before the call reaches this package's `runPromptobus` — so as far as this catch is concerned, the `'ResolveError'` branch matches nothing reachable and is dead.

The risk the string-matching creates is real for the three live classes: a rename of `GateError`, `PromptobusError` or `HostResolveError` — or any class sharing one of those names by coincidence — silently changes `constructor.name` and the catch stops recognizing it, dumping a raw stack trace at a user for what is meant to be a one-line diagnosis (the comment at lines 372-375 states exactly this intent for `PromptobusError`). There is currently no test on this catch block at all — `grep -n "expected\|constructor.name" test/cli.test.mjs` finds nothing.

## Work to do

- Import `{ GateError, PromptobusError }` from `../dist/index.js` and `{ HostResolveError }` from `../dist/host.js` in `lib/cli.js` (same pattern as `lib/harness-home.js`, `lib/models.js`, `lib/liftoff.js`, `lib/host.js`).
- Replace the three name-string comparisons with `e instanceof GateError`, `e instanceof PromptobusError`, `e instanceof HostResolveError`.
- Delete the `e?.constructor?.name === 'ResolveError'` line — it matches nothing this package can throw or receive through `runPromptobus`.
- Add a case to `test/cli.test.mjs`: a thrown `GateError`/`PromptobusError`/`HostResolveError` reaches the catch and exits via `fail(e.message)` with no stack printed, while a plain `Error` (or an unrelated class merely named `GateError`) does print its stack — proving the fix closes the name-collision gap the old string comparison had.

## Out of scope

- Any change to what makes an error "expected" beyond the four existing classes — this is a mechanical instanceof swap plus removal of one dead literal, not a redesign of the catch's policy.

## Verification

- `npm test` passes, including the new `test/cli.test.mjs` case.
- `grep -n "constructor?.name" lib/cli.js` returns nothing; `grep -n "ResolveError" lib/cli.js` returns nothing.

## Triage — 2026-09-07

- **Track:** L — Spawn, review and command guidance.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/cli.js:369`, `src/protocol.ts:49`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Do not use the suggested grep for ResolveError as a zero-hit criterion: HostResolveError contains that substring. Check removal of the exact obsolete comparison and test actual exception instances.
