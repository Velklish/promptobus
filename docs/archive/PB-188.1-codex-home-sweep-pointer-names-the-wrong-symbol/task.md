# PB-188.1 · A fourth wrong binding: the home-sweep section named a symbol declared in another file

- **Scope:** `lib/driver-codex.js`, [drivers reference](../../reference/05-drivers.md)
- **Created:** 2026-09-16
- **Dependencies:** found by the semantic gate rebuilt in `PB-188`; corrected in the same pass

## Context

The reviewer of the release run found three wrong pointer bindings by hand and they were
corrected there. The rebuilt semantic gate found a **fourth** of the same class, and this one
had never been read by a person.

Before the correction, `lib/driver-codex.js` carried this comment above a CALL, and the
heading it pointed at was `bindParticipantHomeRemoval — remove every home under the root that
no session record names`:

```js
/** Remove every home under the root that no session record names.
 * [reference/05-drivers.md#bindparticipanthomeremoval--…](../../backlog/triage/…) */
bindParticipantHomeRemoval(removeParticipantHome);
```

Three facts, each checkable:

- `bindParticipantHomeRemoval` is declared in `lib/codex-session.js`, not in
  `lib/driver-codex.js`; this file only imports it and calls it. The section's `Source:` line
  named `lib/driver-codex.js`, so the file it pointed at did not hold the symbol it named.
- The prose of the section — "remove every home under the root that no session record names" —
  describes `sweepParticipantHomes`, declared on the line after that call. Registering a
  home-removal callback is not sweeping homes.
- The comment therefore stood above no declaration and inside no symbol, which is how the gate
  reported it: `lib/driver-codex.js:236 names \`bindParticipantHomeRemoval\` and stands above
  no declaration and inside no symbol`.

This is the defect class the withdrawn gate certified as absent — "98 pointers, 0 discrepancies
by symbol" — and it survived that certificate because the old check never compared
`section.file` and accepted a bare call as a declaration.

## What was done

The heading and its `Source:` line name `sweepParticipantHomes`, and the comment moved below
the call so that it stands above that declaration:

<!-- quote:../../reference/05-drivers.md -->
### `sweepParticipantHomes` — remove every home under the root that no session record names

Source: `lib/driver-codex.js`, `sweepParticipantHomes`.
<!-- /quote -->

In the code the comment now sits below the call, so that the line it stands above is the
declaration the section names:

<!-- quote:../../../lib/driver-codex.js -->
export function sweepParticipantHomes(env = process.env) {
<!-- /quote -->

## Out of scope

- Every other pointer of the tree: the rebuilt gate classifies all 173 and refuses none.
- The gate itself, which is `PB-188`.

## Verification

- `node --test test/comment-links.test.mjs` is green, and `unbound` does not appear in the
  classes of `test/fixtures/comment-links-baseline.json`.
- Measured on the tree at `7a7d146^`, before the three hand corrections: the rebuilt gate is
  red on this binding there as well, at `lib/driver-codex.js:308`.
