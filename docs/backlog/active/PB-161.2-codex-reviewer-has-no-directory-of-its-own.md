# PB-161.2 · A Codex reviewer works in the tree under review, so it gets no workspace skills and no project trust

- **Scope:** `lib/driver-codex.js` (`prepare`, the reviewer working directory), `lib/review.js`, [03-cli](../../reference/03-cli.md) § Review, `test/promptobus-driver-codex.test.mjs`
- **Created:** 2026-09-11
- **Dependencies:** PB-161
- **Taken:** 2026-09-11

## Context

Finding discovered while working on PB-161. A Codex reviewer's working directory is the
directory under review — usually a worker's worktree. Two things follow, and PB-161
accepted both rather than widen its scope.

**No workspace skills.** The Cursor driver copies its skills canon into a sandbox of its
own (`reviewSandbox`), precisely so that the mechanism writes no files into a foreign
tree. Codex has no such sandbox, so PB-161 copies the canon for a worker only and says
so in the reviewer's lift line: `not attached — a Codex reviewer works in the tree under
review, and the mechanism writes no files there`. The review procedure arrives as a
module skill, and a Codex reviewer therefore does not have it, while a Claude Code or
Cursor reviewer does — a hole in harness parity, not a Codex property.

**No project trust.** ADR-007 trusts the worker's worktree and deliberately not the
reviewer's working directory: a trusted project's own `.codex/config.toml` puts MCP
servers into the session, measured on codex-cli 0.146.0 (one stand, three runs: no
record — the project's server does not come up and stderr says the project is untrusted;
the realpath record — it comes up; the unresolved `/var/…` spelling — it does not). A
repository must not hand servers to the session judging it. The cost is that a Codex
reviewer also does not read the repository's own `.codex/agents`.

## Work to do

- Decide whether a Codex reviewer gets a working directory of its own — the Cursor
  driver's `reviewSandbox` shape, with the reviewed tree attached through
  `runtimeWorkspaceRoots` as it already is for rules — or stays in the reviewed tree
  without skills.
- If it gets one: the skills copy and the trust record follow it there, the containment
  roots move with it, and 03-cli § Review says what the reviewer's directory is.

## Out of scope

- The worker's copy and the worker's trust record — PB-161 and ADR-007.
- The tracked-path hazard of the copy — PB-161.1.

## Verification

- A lifted Codex reviewer reads a skill from the workspace canon, or 03-cli § Review
  records the decision not to give it one and names what it costs; the reviewed tree
  gains no file from the lift either way; `npm test` green.
