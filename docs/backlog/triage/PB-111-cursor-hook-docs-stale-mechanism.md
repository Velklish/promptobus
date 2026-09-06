# PB-111 · The install and hooks-and-trust guides still promise a Cursor `postToolUse` bus hook with `--output additional_context` that the installer deliberately stopped writing, so a Cursor user debugging missing bus feedback is pointed at a mechanism that no longer exists

- **Scope:** `docs/guides/install.md`, `docs/guides/hooks-and-trust.md`, `lib/install.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Re-verified byte-for-byte against current HEAD. `docs/guides/install.md:99`: "| Cursor | `.cursor/hooks.json` (`version` 1) | `postToolUse` with `--output additional_context` | `stop` |". `docs/guides/hooks-and-trust.md:14` repeats it in its table; `hooks-and-trust.md:59` repeats it in prose: "Bus feedback arrives as `additional_context` because install passes `--output additional_context`."

Actual behavior: `lib/install.js:206-208` — `function cursorEvents(_busCmd, guardCmd) { return { stop: [{ command: guardCmd }] }; }` — the bus-command argument is discarded; only `stop` is ever written for Cursor. The adjacent comment at `lib/install.js:229-230` says so explicitly: "busEvent is only for stripping a leftover bus group from an older install. Owned Cursor writes are `stop` alone. Bus feedback for this harness is driver injection." `grep -rn additional_context` over `lib/`, `src/`, `templates/` returns nothing — the string occurs only in the three stale prose spots above. The corrected behavior is already tested and stable: `test/hooks.test.mjs:87` and `test/install.test.mjs:196` both assert the Cursor `postToolUse` group is absent/empty.

## Work to do

- Edit `docs/guides/install.md:99`'s Cursor row's "Bus feedback" cell to name driver injection instead of a `postToolUse` hook; keep `stop` in the "Loop guard" cell as-is
- Edit `docs/guides/hooks-and-trust.md:14` (table row) and `:59` (prose) the same way, matching `lib/install.js:229-230`'s own explanation
- Cite the existing regression test (`test/hooks.test.mjs:87` or `test/install.test.mjs:196`) from the corrected table/prose so the claim stays anchored to a running check — no new test needs writing

## Out of scope

- Writing a new test — the assertion that Cursor's owned hooks contain no `postToolUse` group already exists and passes
- The Claude and Codex rows of the same tables, which were checked against `lib/install.js:211-254` and are accurate

## Verification

- Neither `docs/guides/install.md`'s Cursor row nor `docs/guides/hooks-and-trust.md`'s Cursor row/prose mentions `postToolUse` or `additional_context`
- `grep -rn additional_context docs/guides/` returns nothing
- `test/hooks.test.mjs` and `test/install.test.mjs` still pass unchanged
