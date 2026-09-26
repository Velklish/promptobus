# ADR-023: install owns the package's process skills

**Status:** Proposed
**Date:** 2026-09-26
**Deciders:** the owner, in the planning dialogue of 2026-09-26. The text is drafted by the planning session and is not yet reviewed by the owner; the status turns Accepted when PB-268 lands.

## Context

The package ships `skills/orchestrate` and `skills/solo-review` and installs nothing of them: `lib/install.js` writes hooks only, and a participant sees skills through `host.pluginDir()`, `null` on the standalone host. Consumers therefore keep their own retelling of roles and steps, which drifts from the package at the first pin. With a declared pipeline and a task tree the texts change more, not less.

## Options

- A. The consumer owns a copy and updates it by hand. Rejected by the owner: the package is placed in one place and works; its documentation is not the consumer's to own.
- B. `install` lays out the package's skills into each listed harness's project skill location with an ownership marker, `install --check` detects drift, `uninstall` removes owned files only, and an update of the package followed by `install` replaces the texts.

## Decision

B. For Claude Code the location is `.claude/skills/<name>/SKILL.md`. For Cursor and Codex the location is measured in the card and recorded in the driver with its source; a harness with no project skill location is reported at install, not guessed.

## Consequences

- The installer's ownership rules for hooks — keep foreign entries, remove only owned ones — apply to skill files as well.
- Consumer texts shrink to policy above the package; the roles, the steps and the tree are read from the package's own skill.
- `install --check` becomes the drift gate for documentation as it is for hooks.
