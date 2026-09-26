# PB-268 · promptobus install lays out the package's process skills and owns them

- **Order:** 50
- **Scope:** [guides/install.md](../../guides/install.md), [02-host](../../reference/02-host.md), `lib/install.js`, `src/hooks.ts`, `skills/`
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** major

## Context

`promptobus install` writes the project-level hooks of the listed harnesses and nothing else: `grep -n -i skill lib/install.js` finds no line. The package ships `skills/orchestrate` and `skills/solo-review` in the tarball, but the orchestrator's own session only sees them if the consumer copies or links them, and a participant sees them only through `host.pluginDir()`, which the standalone host answers `null`. The result is that consumers keep their own retelling of the roles and the step order, and it drifts from the package on the first pin.

The owner decided on 2026-09-26 (ADR-023): the package lays out its own process documentation at install time and owns it; the consumer does not hold a copy, and an update of the package followed by `install` updates the texts.

## Work to do

- `install --harnesses <list>` writes every skill under `skills/` into the project skill location of each listed harness, with an ownership marker in the file, next to the hooks it already owns. For Claude Code the location is `.claude/skills/<name>/SKILL.md`.
- For Cursor and Codex the location is measured first — their documentation and a live read of what a project session loads — and recorded in the driver with the source quoted; a harness with no project skill location is reported as such at install rather than guessed.
- `install --check` exits 1 when an owned skill file drifted from the package or is missing; `uninstall` removes owned skill files only and keeps foreign ones beside them; `promptobus.json` records the installed list as it does for hooks.
- The install guide and README describe the layout and its ownership.

## Out of scope

- The content of the skills: PB-272 rewrites them for the tree; this card is the delivery.
- Participant skills: workers, reviewers and approvers keep receiving skills through the host as today.

## Verification

- After `install --harnesses claude` the project holds the package's orchestrate skill; `install --check` exits 0; editing the file by hand makes it exit 1; `uninstall` removes it and leaves a foreign skill directory untouched.
- The installed skill text is byte-identical to `skills/orchestrate/SKILL.md` of the installed package version.
- For each of Cursor and Codex the card's result names the location and quotes its source, or names the harness as having none.
