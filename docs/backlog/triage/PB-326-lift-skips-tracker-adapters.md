# PB-326 · A lift installs dependencies but leaves the project tracker's adapters unlaid, so the writer skills are missing in the worktree

- **Scope:** [03. CLI § Spawn](../../reference/03-cli.md#spawn)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** minor

## Context

A lift runs `npm ci` in the new worktree and prints "worktree dependencies installed". It does not run the project tracker's adapter step. backslop's adapter outputs, among them the `backslop-writer`, techdoc and humanizer skills, are generated and ignored by git, so a fresh worktree has none of them until `npx --no-install backslop init`.

In run bs020 on 2026-10-03 every writer brief had to start with that `init`. The ati-agents approver of BL-730 could not run it, because the Claude Code auto-mode classifier refused the command. The diffalanche teamlead found only three stale backslop skills in its main clone. `lib/project-hooks.js` already reads `backslop.json` and its `cli` (`TRACKER_CONFIG`, `trackerCli`), but only for hook records.

## Work to do

- When the worktree has a `backslop.json` with a `cli`, run `<cli> init` after the dependencies, check that `git status` stays clean, and print the outcome on the lift's output.
- A failed `init` warns and does not stop the lift.

## Out of scope

- Projects without a `backslop.json`.

## Verification

- A lift into a fixture project with `backslop.json` leaves the writer skills in the worktree and a clean `git status`; a test fails on the old lift.
