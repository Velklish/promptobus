# PB-161.1 · The lift warns about a tracked `.cursor` path it is about to overwrite, and says nothing about a tracked `.codex` one

- **Scope:** `lib/spawn.js` (`warnTrackedCursor`), `lib/driver-codex.js` (`prepare`), [03-cli](../../reference/03-cli.md) § Spawn
- **Created:** 2026-09-11
- **Dependencies:** PB-161
- **Taken:** 2026-09-11

## Context

Finding discovered while working on PB-161. Since that task the Codex driver copies the
workspace `.codex/skills` canon into the worker's worktree, and the copy WIPES its
destination first — `copyLaunchTree` removes the destination before copying, so that a
repeat lift does not leave a skill that has since vanished from the canon.

`spawn` already has a guard for exactly this hazard, and it is spelled for one harness:
`warnTrackedCursor` (`lib/spawn.js`) runs `git ls-files -- .cursor` for every launch
file under a `.cursor` directory and warns that "lift will overwrite them and the tree
will be dirty". 03-cli § Spawn says the same in one sentence, naming `.cursor`.

Nothing does this for `.codex`. A repository that tracks `.codex/skills` of its own —
which is a lawful thing for a repository to do, since Codex reads that directory in any
project — gets it silently replaced by the workspace canon at lift. The worker's branch
is then dirty from its first second, and `done` will not sweep the directory. Unverified
as a live reproduction: the hazard is read off `copyLaunchTree` and `warnTrackedCursor`,
not observed on a repository that tracks the path.

## Work to do

- Decide whether the guard becomes harness-neutral (the driver names the directories its
  launch files claim, and `spawn` asks Git about those) or whether the Codex driver
  carries its own check and skips the copy with an honest `skillsNote` when the
  destination is tracked.
- Whichever way, 03-cli § Spawn stops naming one harness and names the rule.

## Out of scope

- The copy itself and where it lands — PB-161 and ADR-007.
- Giving the Codex reviewer a directory of its own — PB-161.2.

## Verification

- A worktree whose repository tracks a file under `.codex/skills` produces the same
  warning that a tracked `.cursor` path produces today, or the copy is skipped and the
  lift line says why; `npm test` green.
