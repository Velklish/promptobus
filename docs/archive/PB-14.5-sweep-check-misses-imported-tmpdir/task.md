# PB-14.5 · The sweep-prefix check sees only the literal os.tmpdir() spelling, so a sandbox built from an imported tmpdir() is never demanded or swept

- **Scope:** `test/tmpdir-sweep.test.mjs`, `test/model-routing-preflight.test.mjs`
- **Created:** 2026-09-05
- **Dependencies:** none
- **Taken:** 2026-09-05

## Context

Finding discovered while working on PB-14, measured by the Cursor adapter track on 2026-09-05. `test/tmpdir-sweep.test.mjs` lines 271–273 find suite sandbox literals with two patterns: one for `makeSandbox('…')` and one for `mkdtempSync(path.join(os.tmpdir(), '…'))`. The second requires the literal spelling `os.tmpdir()`. A file that does `import { tmpdir } from 'node:os'` and writes `path.join(tmpdir(), '…')` is invisible to the check, so its prefix is never demanded and never swept. Live evidence: `test/model-routing-preflight.test.mjs` (PB-14) builds its sandbox that way with the prefix `promptobus-routing-`, which is absent from `SUITE_PREFIXES`, and the check named "the sweep prefix list covers every suite sandbox" stays green. The adapter tracks copied the same spelling; the Cursor and Codex tracks added `'promptobus-adapter-'` by hand, not because the gate asked.

## Work to do

- Widen the second pattern to the imported form (`tmpdir()` with or without the `os.` prefix, `path.join` or a bare `join`), then add every prefix the widened gate demands — `promptobus-routing-` at least — and let the check go red on the next unlisted one.

## Out of scope

- Rewriting the sweep itself.

## Verification

- Mutation probe: remove `promptobus-routing-` from `SUITE_PREFIXES` after the widening — the check goes red; today it does not.
