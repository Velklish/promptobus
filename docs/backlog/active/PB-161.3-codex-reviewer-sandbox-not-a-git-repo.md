# PB-161.3 · Nothing measured says whether Codex reads `.codex/skills` from a directory that is not a git repository

- **Scope:** `lib/driver-codex.js` (`reviewSandbox`, `spawn`), [03-cli](../../reference/03-cli.md) § Review, [ADR-008](../../adr/adr-008-codex-reviewer-working-directory.md)
- **Created:** 2026-09-11
- **Dependencies:** PB-161.2
- **Taken:** 2026-09-12

## Context

Finding discovered while working on PB-161.2. Since that task a Codex reviewer works in a
directory of its own — `<participant settings stem>.codex-sandbox` in the task store —
and the workspace `.codex/skills` canon is copied there. That directory is NOT a git
repository, and nothing is under it that would make it one.

The Cursor sandbox is `git init`-ed at lift, for a measured reason: Cursor reads the
project `.cursor/mcp.json` only inside a repository (REPORT §4.2), and without the init
the reviewer would come up with no bus. Codex has no such known condition — its MCP set
comes from the participant home's `config.toml`, not from the working directory — and
PB-161's measurement of the skills path ("Codex reads a project's `.codex/skills`
whether or not the project is trusted") was taken in a worker's WORKTREE, which is a git
repository. So the measurement covers trust and does not cover repository-ness.

Unverified in both directions: nothing observed says Codex needs a repository to read a
project's `.codex/skills`, and nothing observed says it does not. PB-161.2 refused to
`git init` the sandbox on that basis — a precondition no measurement asked for is not
invented — and recorded the gap here rather than hiding it. If the answer turns out to be
"a repository is required", a Codex reviewer silently has no workspace skills and the
parity hole PB-161.2 claims to have closed is still open.

## Work to do

- Measure it. One stub skill in the workspace canon whose `SKILL.md` carries a marker
  string, a Codex reviewer lifted by `promptobus review <path> --harness codex`, and a
  prompt asking it to return that marker. Two runs against the same sandbox path: as the
  lift leaves it, and after `git init -q` in it. The observable is the marker in the
  reviewer's `result` message, not a file listing — the question is whether the harness
  READ the copy, and the copy's presence on disk is already checked by the suite.
- A paid model turn is what this costs, and the run that filed this card had no budget
  for one. It is a measurement, not a fix: schedule it where the owner's Codex window has
  room.
- Marker absent in both runs — the problem is not repository-ness and this card is the
  wrong shape; say so and open the real one. Marker absent without the init and present
  with it — `spawn` `git init`s the sandbox the way the Cursor driver does, and the
  unverified paragraph in 03-cli § Review and the ADR-008 consequence both become a
  measurement.

## Out of scope

- Where the reviewer's directory is and what else lands in it — PB-161.2 and ADR-008.
- The worker's copy, which lands in a worktree and is therefore not affected.

## Verification

- 03-cli § Review and ADR-008 no longer say the point is unmeasured: they name the stand,
  the command and what was observed, the way the rest of the Codex measurements do.
