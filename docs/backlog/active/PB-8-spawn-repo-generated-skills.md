# PB-8 · spawn lays out the workspace canon but not the repository's own generated process skills

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none
- **Taken:** 2026-09-05

## Context

Reported by a worker and measured by the orchestrator on 2026-09-04. `spawn` lays out the workspace canon for a participant (MCP set, base skills) and assumes the repository's own skills travel with the checkout. A repository that *generates* its process skills (this one: `backslop init` writes them and `.gitignore` keeps them out of git) hands the participant a worktree without them — three workers came up without `.cursor/rules/backslop-*.mdc`; one noticed and said so, two did not. Running the generator inside each worktree restored the files and left `git status` clean, so the operation is safe for the participant's branch.

## Work to do

- Let the repository declare how to restore its generated skills (a manifest field or a host hook), and let `spawn` run it in the fresh worktree — or state in the docs that repository skills must live in git, and reconcile that with the generated-skills convention.
- Whichever way: the participant preamble names whether repository skills were laid out.

## Owner's decision (2026-09-05)

The repository declares its generator: a field in the repository's `promptobus.json` (a command that restores generated process skills), `spawn` runs it in the fresh worktree after the checkout, and the participant preamble names whether repository skills were laid out (and the command's exit code when it failed). Skills in git stay the default; the field is optional.

## Out of scope

- Nothing named yet.

## Verification

- Spawn test with a repository that declares a generator: the worktree has the generated files, `git status` is clean.
