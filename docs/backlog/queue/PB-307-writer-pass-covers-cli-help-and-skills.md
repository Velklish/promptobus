# PB-307 · Extend the technical-writer currency check to CLI help and shipped skills

- **Order:** 600
- **Scope:** [Releasing § Technical-writer pass](../../guides/releasing.md#technical-writer-pass)
- **Created:** 2026-09-27
- **Dependencies:** none
- **Cost:** major

## Context

The release procedure runs a technical-writer pass before each release. Its currency part checks the documentation against the code changed since the previous tag. The pass of 0.20.0 found three stale sentences, yet it missed a stale `spawn --teamlead` help and a stale orchestration skill (PB-306): both still refuse a Codex teamlead that the code admits. Neither was in the pass's scope.

Evidence: the overlay limits the walk to documentation files.

<!-- quote:../../../.agents/skills/tech-writer/SKILL.md -->
Walk human-facing documentation: `README.md`, `README.ru.md`, `CHANGELOG.md`, `docs/README.md`, `docs/GLOSSARY.md`, `docs/guides/`, `docs/reference/`.
<!-- /quote -->

The terminal help in `lib/cli.js` is text a person reads. The shipped skills under `skills/` are text an agent acts on. Both state behaviour and go stale the same way as the reference.

## Work to do

- The currency part of the pass also checks the CLI help text and the shipped skills under `skills/` against the code changed since the previous tag.
- The style part stays on human-facing text. It covers the CLI help, not skills: skills are written for agents.
- `docs/guides/releasing.md` and the overlay state the new scope. The check that guards the release procedure follows it.

## Out of scope

- Vendored third-party skills under `.agents/skills/` other than the overlay.
- Fixing the stale help and skill themselves (PB-306).

## Verification

- The release-procedure check is red when the guide or the overlay drops CLI help or `skills/` from the currency scope.
- The next release's currency ledger has rows for the CLI help and each shipped skill.
