# PB-299 · Make legacy fixture provenance and recovery instructions usable from the public repository

- **Order:** 490
- **Scope:** [04-protocol](../../reference/04-protocol.md)
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

The legacy fixture manifest contains damaged sentences and points readers at Git objects absent from a complete public checkout.

## Evidence

- At b3d4a387, test/fixtures/promptobus/MANIFEST.md:24 instructs `git show e2ea30a^:scripts/make-promptobus-fixture.mjs`. In the complete audit clone that command exited 128: `fatal: invalid object name 'e2ea30a^'.`

- `git rev-parse --is-shallow-repository` exited 0 and printed false. `git cat-file -t 8ca22be` for the baseline revision at MANIFEST:9 exited 128: `fatal: Not a valid object name 8ca22be`.

- MANIFEST:3 contains empty provenance brackets and says migration will read the fixture later; test/promptobus-migration.test.mjs:3-8,55 already consumes it, as MANIFEST:55 also acknowledges.

## Work to do

- Restore meaningful, self-contained provenance prose and identify both current fixture consumers.
- Replace the unusable generator-recovery command with a public, reproducible source if one exists; otherwise state that the original generator/commit is not preserved in this repository and explain how the frozen fixture is maintained.
- Do not regenerate or alter the 17 frozen legacy fixture files merely to repair documentation.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- Every remaining Git recovery command succeeds in a fresh full public clone, or its unavailable historical source is explicitly identified without presenting a working command.
- No empty brackets or future-only migration description remains; legacy and migration consumers are named.
- Frozen fixture content is byte-for-byte unchanged.
