# PB-47 · The orchestrate skill's CLI synopsis hand-copies lib/cli.js and has drifted by 11 flags, so an orchestrating session reading it does not know spawn, done and review accept them

- **Scope:** [reference/03-cli](../../reference/03-cli.md), `skills/orchestrate/SKILL.md`, `lib/cli.js`, `test/cli.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Diffed against `lib/cli.js`'s `parseArgs` option objects and `helpText()` (current tree, `v0.5.0`, commit `cc1aca8`):

- `skills/orchestrate/SKILL.md:43` (`spawn`) is missing `--model <m>`, `--effort <e>`, `--permission-mode <p>`, `--refresh` — all parsed in the `case 'spawn'` block at `lib/cli.js:292-309`.
- `skills/orchestrate/SKILL.md:45` (`done [--task <id>]`) is missing `--keep-sessions` — parsed at `lib/cli.js:329-331`.
- `skills/orchestrate/SKILL.md:49` (`review`) is missing `--base <ref>`, `--model <m>`, `--effort <e>`, `--permission-mode <p>`, `--refresh`, `--dry-run` — all present both in the `case 'review'` block (`lib/cli.js:193-208`) and in `helpText()` (`lib/cli.js:26-27`).

That is 4 + 1 + 6 = 11 flags, all genuinely parseable options, not just help-text prose. `test/cli.test.mjs`'s only drift gate is `subcommands()` (line 78) plus the test at line 90, "no message names a command the CLI does not have" — it walks `jsFiles(LIB)` for stray command names and never opens `skills/`, and there is no flag-level check anywhere in the suite.

## Work to do

- Correct the three synopsis lines in `skills/orchestrate/SKILL.md` (lines 43, 45, 49) to include the missing flags, matching `lib/cli.js`'s `helpText()`.
- Extend `test/cli.test.mjs`'s existing drift-gate section, next to `subcommands()`: for each of `spawn`, `done`, `review` (and any other command with a fenced synopsis in a `skills/*/SKILL.md`), extract the flag set from that command's `parseArgs` `options: {...}` object in `lib/cli.js`, extract the flag set referenced in the matching ```bash``` fenced line(s) of the skill file, and assert the two sets are equal — cli.js as sole source of truth, the same role it already has for command names.

## Out of scope

- Auto-generating the synopsis block from `lib/cli.js` at build time — the gate only needs to catch drift, not eliminate the hand-written copy.

## Verification

- The new test fails on the current `skills/orchestrate/SKILL.md` (11 missing flags) and passes once the three lines are corrected.
- Adding a flag to `spawn`, `done` or `review` in `lib/cli.js` without updating the skill's synopsis turns the test red.
