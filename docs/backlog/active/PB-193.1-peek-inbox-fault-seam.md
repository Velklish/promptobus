# PB-193.1 · peekInbox has no FaultHook seam — its ENOENT half is tested with a dangling symlink, not an injected errno

- **Scope:** `src/v1/engine.ts` (`peekInbox`), `test/store.test.mjs`
- **Created:** 2026-09-16
- **Dependencies:** none
- **Parent:** PB-193
- **Taken:** 2026-09-17

## Context

`PB-193` split ENOENT from every other read failure in `peekInbox`: a missing inbox is
"absent", an unreadable one is a `BrokenNote` with its code. `readInbox` and `glanceInbox`
take their failures through the FaultHook seam, so their tests inject an errno; `peekInbox`
reads the disk directly, so the closing tests had to build the failures on disk — a dangling
symlink for ENOENT and a `chmod 000` directory for EACCES, the latter skipped on win32 and
under uid 0. The uid-0 branch was never exercised, and the two probes of that card were run
against `dist/` with `--stdin-patch` because the seam was not there to break.

> Source: 2026-09-16, `PB-193` result.md, open item; `src/v1/engine.ts` on `main` at
> `77b382f`.

## Work to do

- Route `peekInbox` reads through the same FaultHook seam as `readInbox` and `glanceInbox`.
- Rewrite the two peek failure tests as errno injections; keep the dangling-symlink test as
  the one real-disk witness.

## Out of scope

- The classification itself (ENOENT vs the rest) — closed by `PB-193`.

## Verification

- The peek failure cases in `test/store.test.mjs` run on win32 and under uid 0 with no skip.
- Mutation probe: drop the seam call in `peekInbox` — both injected cases redden, the
  symlink case stays green.
