# PB-317 · Move the tracker to backslop v0.20.0 and use its writer skills instead of the vendored copies

- **Scope:** [01. Overview](../../reference/01-overview.md)
- **Created:** 2026-10-03
- **Dependencies:** none
- **Previous order:** 115
- **Taken:** 2026-10-03

## Context

backslop v0.20.0 was released on 2026-10-03; this repository pins v0.10.1. A trial `npx github:Velklish/backslop#v0.20.0 upgrade --to 0.20.0` on a throwaway clone of `bab39b19` exited 0, and `lint` after it exited 0 with no errors. What the upgrade leaves undone, measured on that clone:

- `npm run pins` exits 1: `test/gate-record.test.mjs` lines 26, 155 and 159 still name `#v0.10.1`; `upgrade` never rewrites test files.
- `npm test`: one of 110 files red, `docs-links.test.mjs`, "task dependencies match the baseline — added docs/ROLES.md -> backlog/README.md": `migrate` lays the new `docs/ROLES.md`, which links the backlog rules.
- v0.20.0 lays out three writing skills for every selected adapter: `backslop-writer` (the technical-writer pass, with `writer.style` and `writer.currency` globs in `backslop.json`), `backslop-techdoc` and `backslop-humanizer`. This repository carries its own vendored `humanizer` and `technical-documentation` and a `tech-writer` overlay under `.agents/skills/`, checked by `test/release-writer.test.mjs` and named by `docs/guides/releasing.md`. The overlay's "Do not restyle an accepted ADR. Supersede it." contradicts the new ADR rule of the tracker: a changed decision rewrites its ADR in place.
- Step 5 of the new `AGENTS.md` block commits the draft with `--cleanup=verbatim`; the local "Acceptance trailer" section still gives the command without it.
- `migrate` redraws `docs/backlog/README.md`: its first line names the prefix instead of the product name, and that edit is lost on every upgrade.
- `docs/ROADMAP.md` stays as project content: it is linked from `CHANGELOG.md`, `docs/README.md` and `docs/reference/README.md`.

## Work to do

- Run `upgrade` to v0.20.0 and fix what it leaves: the pins in `test/gate-record.test.mjs`, the docs-links baseline, the `--cleanup=verbatim` flag in the acceptance-trailer command.
- Select the agent hooks for Claude Code only (`init --hooks claude`): the Codex and Cursor drivers collide with project hook files until PB-311 lands.
- Replace the vendored writing skills and the overlay with backslop's: delete `.agents/skills/humanizer`, `.agents/skills/technical-documentation` and `.agents/skills/tech-writer`; move the overlay's scope into `writer.style` and `writer.currency`, and any local rule `backslop-writer` does not already carry into `docs/guides/contributing.md`; point `docs/guides/releasing.md` at the `backslop-writer` release mode; rewrite `test/release-writer.test.mjs` to check what still applies.
- A CHANGELOG entry in the unreleased section, without task ids: lint gate 15 now reads that section.

## Out of scope

- Accepting foreign hook records in the Codex and Cursor drivers: PB-311.
- Replacing `npm run docs-links:external` with `links --external`, and `test/docs-task-independence.test.mjs` with lint gate 15: both of ours read more files than the tracker's.

## Verification

- Every command in `gates` of `backslop.json` exits 0 on the final commit.
- `git ls-files .agents/skills` lists no `humanizer`, `technical-documentation` or `tech-writer` file, and `init` lays the three backslop writing skills for each adapter.
