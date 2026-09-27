# PB-305 · Run the first technical-writer pass before release 0.20.0

- **Order:** 550
- **Scope:** [Documentation index](../../README.md), [Reference](../../reference/README.md)
- **Created:** 2026-09-27
- **Dependencies:** PB-290, PB-291, PB-292, PB-293, PB-294, PB-295, PB-296, PB-297, PB-298, PB-299, PB-300, PB-301, PB-302, PB-303, PB-304

- **Cost:** major

## Context

This is the first technical-writer pass under the release procedure of PB-304, run before release v0.20.0. The documentation-audit cards (PB-290 … PB-302) and the ADR consolidation (PB-303) fix known defects one by one. This pass reads the human-facing documentation as a whole, against the code and against the changes since v0.19.0. It also removes AI-generated prose patterns.

## Work to do

- Load the overlay skill `.agents/skills/tech-writer/SKILL.md` and the skills it names.
- Scope: the human-facing documents the overlay lists — `README.md`, `docs/README.md`, `docs/GLOSSARY.md`, `docs/ROADMAP.md`, `docs/guides/`, `docs/reference/`, `docs/adr/`, and the `## [Unreleased]` section of `CHANGELOG.md`. `README.ru.md` is checked for parity with `README.md` only.
- Out of scope: released CHANGELOG sections, agent-facing texts, `docs/backlog/`, `docs/archive/`, code.
- **Currency.** For each change in `git diff v0.19.0..HEAD` that alters behaviour, a flag, an output or a file layout, confirm the documentation says what the code now does. Fix it where it does not, and cite `file:line` of the code in the evidence.
- **Slop.** Remove the patterns the humanizer names, under the overlay's local rules. Never change a behavioural statement in the process without checking it against the code.
- One commit per document group (reference, guides, ADRs, README and index, CHANGELOG), so that review can follow them.
- Findings that need a code change or a decision are filed as cards, not fixed here.

## Out of scope

- Runtime changes, new documentation sections without a code subject, restructuring the documentation set, publication.

## Verification

- The evidence lists every behaviour-changing commit since v0.19.0 and the documentation location that reflects it, or states why none is needed.
- A reviewer samples the rewritten passages against the code, and finds no changed meaning and no new unverified claim.
- All regression checks added by PB-290 … PB-304 stay green; `backslop gates` passes.
