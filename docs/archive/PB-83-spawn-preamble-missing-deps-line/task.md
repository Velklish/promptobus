# PB-83 · The participant preamble names the repository generator's outcome but says nothing about the dependency install that runs right after it, so a worker learns of `npm ci` only when the brief happens to say so by hand

- **Order:** 740
- **Scope:** [reference/03-cli](../../reference/03-cli.md) § Spawn, `lib/spawn.js`, `lib/worktree.js`, `skills/orchestrate/SKILL.md`, `test/promptobus-spawn.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** PB-126

## Context

`buildPrompt` (`lib/spawn.js:476-511`) interpolates `repoSkillsLine(repoSkills)` at line 482 and mentions dependencies nowhere: `sed -n '476,512p' lib/spawn.js | grep -i "depend\|npm"` returns nothing. Spawn installs them anyway, right after the generator and the launch files are written: `lib/spawn.js:1304-1318`
```
  const rebuilt = plan.rebuild(repoSkills);
  ...
  writeLaunchFiles(plan.launch.files);

  if (freshWorktree) {
    if (worktreeHasLock(plan.worktreePath)) {
      info(`installing dependencies from package-lock.json (${npmCiCommand()})`);
    }
    sayWorktreeDeps(installWorktreeDeps(plan.worktreePath));
  }
```
`installWorktreeDeps` (`lib/worktree.js:371-388`) runs `npm ci --no-audit --no-fund` when a fresh worktree has a `package-lock.json` and returns `{ ran, ok, ms, why, command, logPath, ignored }`; `sayWorktreeDeps` (`lib/spawn.js:1086-1097`) speaks that outcome to the **operator's terminal only** (`ok(...)` / `warn(...)`), not into the prompt. `skills/orchestrate/SKILL.md` — the package's own generic orchestration guidance — says nothing about the install either (`grep -in "dependenc\|npm ci\|npm install" skills/orchestrate/SKILL.md` is empty), so a worker lifted through this package's own skill into any npm repository is not told about the step at all.

Why this is not a one-line move of `repoSkillsLine`'s pattern: the install runs at `lib/spawn.js:1318`, after `writeLaunchFiles` at `:1312` and after the single `plan.rebuild(repoSkills)` at `:1304` that produces `plan.prompt` — so at the moment the prompt text is fixed, the install has not run and its outcome does not exist yet. The comment directly above this block (`lib/spawn.js:1295-1301`) already states the ordering intent: run the generator before `node_modules` exists, so an `npx …` generator is unaffected while an `npm run …` one would see a populated tree, and states this order is written down in the CLI reference — but the reference's mention (`docs/reference/03-cli.md:31`, on `runRepoGenerator`'s three-way ordering) covers the generator only, not the install that follows it in the same code path.

The underlying problem — a step whose outcome is not known until after the prompt is built — is exactly what this package's own `repoSkillsLine`/`plan.rebuild` mechanism (`PB-8`, archived) was built to solve for the generator: `plan.rebuild(repoSkills)` at `lib/spawn.js:1304` rebuilds `plan.prompt` a second time with the generator's *real* outcome, on the stated principle (`docs/reference/03-cli.md`, restated in `lib/spawn.js:1010-1012`) that "a participant that is never told cannot notice." The install sits one step later in the same function and is not folded into that rebuild, so it does not get the same treatment. A consumer of this package (consumer-cli) hit the practical cost directly: an archived task there measured a worker session hanging 4+ minutes silently re-running `npm install` over a worktree `installWorktreeDeps` had already populated via `npm ci`, and a follow-up task there considered wiring the outcome into the prompt and rejected it on exactly the premise this package's own generator handling later solved — the prompt is built before the step runs — a rejection whose stated reason no longer holds once the generator's rebuild-with-real-outcome pattern (`PB-8`) exists to reuse for the install too. That consumer currently works around the gap by making the brief-writing step responsible for the paragraph by hand, which is not itself part of this package.

## Work to do

- Move the dependency install (`installWorktreeDeps`) to run between the generator rebuild (`lib/spawn.js:1304`) and `writeLaunchFiles` (`lib/spawn.js:1312`), and fold its outcome into that same `plan.rebuild(...)` call so the launch files are still written exactly once, per the invariant `PB-8` established.
- Add a `worktreeDepsLine(state)` function next to `repoSkillsLine`, covering each outcome `installWorktreeDeps` can return: installed (ran, ok) — say so and that the worker need not repeat it; refused (ran, not ok) — name `why` and the `command` to run by hand, and to say so in the first status; no lock (`ran: false`) — say there is nothing to install; and the existing-worktree case (a repeat spawn, install skipped) — say it was not re-run or checked, so look before relying on it.
- Interpolate `worktreeDepsLine(...)` into `buildPrompt` beside `repoSkillsLine(repoSkills)`.
- Update `docs/reference/03-cli.md` § Spawn to document the install's new position in the ordering (generator → dependency install → launch files, or whatever order is chosen) and that its outcome now reaches the participant's own preamble.
- Note the trade-off this reordering introduces: launch files no longer land before the install, so an interrupted `npm ci` (Ctrl+C) leaves a worktree without launch files until a repeat spawn recognizes the journal record and rewrites them — call this out explicitly wherever the ordering is documented, since it is the mirror image of the ordering guarantee `docs/reference/03-cli.md:31` currently states for the generator.

## Out of scope

- Changing when or whether dependencies are installed at all — this only makes the existing install's outcome reach the prompt, on the same model already used for the repository generator.
- Updating the consumer's own brief-writing instructions that currently compensate for this gap by hand — that is a follow-up in that repository once this package's preamble carries the line, not part of this change.

## Verification

- `npm test` passes, including new fixtures in `test/promptobus-spawn.test.mjs` on the model of the existing `installWorktreeDeps`/`sayWorktreeDeps` cases (lock present and install green, install refused, no lock, and a repeat spawn into a surviving worktree) asserting that `plan.prompt` contains the matching `worktreeDepsLine` text for each case.
- A `--dry-run` spawn against a fixture repository with a `package-lock.json` prints the dependency line in the previewed prompt, not only the operator-facing `info(...)`/`ok(...)`/`warn(...)` lines it prints today.

## Triage — 2026-09-07

- **Track:** L — Spawn, review and command guidance.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/spawn.js:476`, `lib/worktree.js:371`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
