# PB-167.1 · The pin also lives in package.json and .github/workflows/ci.yml, which upgrade does not rewrite and lint does not check

- **Order:** 40
- **Scope:** `package.json`, `.github/workflows/ci.yml`, [contributing](../../guides/contributing.md)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Found while raising the pin in PB-167. `backslop upgrade` rewrites the pin in `backslop.json`, in `docs/**` and in root `*.md`. It does not reach `package.json` or `.github/workflows/ci.yml`, and `lint` does not report the divergence.

Measured on run 0912a, worktree `worktree-promptobus-0912a-pb-pin-t20260911-213701`, after `npx github:Velklish/backslop#v0.6.0 upgrade` (exit 0) on `669aaeb`:

- the command reported `pin in prose: 7 files`; `git status --short` listed nine modified files, and neither `package.json` nor `.github/workflows/ci.yml` was among them;
- `grep -rn 'backslop#v' package.json .github/workflows/ci.yml` still answered `v0.4.0` in both;
- `npx github:Velklish/backslop#v0.6.0 lint` exited 0 with `lint: no errors` while both files still named the old pin.

The two references are live commands, not prose, and that is what makes the divergence cost something. The cost itself is an inference and is written here as one.

Measured in the same pass: `init` at a given pin rewrites the `AGENTS.md` backslop block and the adapter output to that version — `npx github:Velklish/backslop#v0.6.0 init`, run by `upgrade`, changed fourteen lines of `AGENTS.md` and replaced step 4 with the one that names the `gates` runner.

Inferred from it: `.github/workflows/ci.yml` runs `init` at the pin it names and then `npm run lint:backslop`, so a workflow left on the old pin would be expected to regenerate the old block and the old adapter output on every push, undoing a raise it was not told about. No CI run was made to check this. The inference was strong enough to act on — PB-167 moved both pins by hand rather than ship a change that might be reverted upstream of it — and it is not strong enough to record as a measurement.

PB-167 fixed both files by hand and recorded the trap in the contributing guide. What it did not close is the guard: the next pin raise has nothing but that paragraph standing between it and the same silent divergence.

## Work to do

- Decide where the guard belongs. Two candidates, and the choice is the owner's:
  - a local check in this repository — a gate that greps every tracked file for a `backslop#vX.Y.Z` spec and fails when one disagrees with `cli` in `backslop.json`, with `CHANGELOG.md`, `docs/adr/**`, `docs/archive/**` and task cards excluded the way `upgrade` excludes them;
  - a report upstream to backslop, as the consumer side of the same shape as `BS-24`: widen the files `upgrade` rewrites and `lint` checks beyond markdown, or have `lint` name every live pin it can see.
- Whichever is chosen, keep the contributing-guide paragraph in step with it.

## Out of scope

- The pin references in `docs/adr/**`, `docs/archive/**` and task cards: `upgrade` leaves those by design — they describe a moment, not a runnable command. `docs/adr/adr-001-process.md` still names `v0.3.0` in four lines for that reason.
- Raising the pin itself — PB-167.

## Verification

- A tracked file carrying a `backslop#vX.Y.Z` spec that disagrees with `cli` in `backslop.json` is red, and the red line names the file and the expected pin.
- The excluded areas above stay green with their historical pins in place.
- A red probe: revert the pin in `package.json` to `v0.4.0` and confirm the guard goes red; restore it and confirm it goes green.
