# PB-404 · BB loads the Promptobus plugins from a participant worktree and a sandbox copy instead of a released checkout

- **Order:** 320
- **Scope:** [integrations/bb](../../../integrations/bb/README.md), [integrations/bb-native-observer](../../../integrations/bb-native-observer/README.md)
- **Created:** 2026-10-27
- **Dependencies:** none
- **Cost:** major

## Context

The [BB adapter README](../../../integrations/bb/README.md) installs the exact build generation `bb plugin install ./.runtime/<buildId>` from whatever source directory ran the build. During the runs of 2026-10-20 to 2026-10-26, the owner's BB got its Promptobus plugins from directories made for one run, not from a released checkout. Nothing says which directory should hold the installed generation or how to move it to a release.

Evidence:

- Source: 2026-10-27, `bb plugin list`: the adapter `promptobus@0.1.0` runs from `integrations/bb/.runtime/<buildId>` inside a participant worktree under `.claude/worktrees/`. That worktree's head is `0948dbbf`, a pre-acceptance PB-374 commit, while `main` (`v0.30.0`) last changed `integrations/bb` in `48af2e09` (PB-373). The installed adapter therefore lacks the accepted Cursor and OpenCode admission. Removing the worktree at `sweep` or `done` would remove the plugin's source.
- Source: same listing: the observer panel `promptobus-native-panel` runs from a disposable sandbox copy, and its view fails with "Selected file exceeds the owned regular-file boundary". A second observer, `promptobus-native-panel-acceptance`, ran from a test fixture under the system temporary directory; it was removed on 2026-10-27 at the owner's request.
- Source: [observer README § Observer boundary](../../../integrations/bb-native-observer/README.md#observer-boundary): the installed observer bundle may carry an owner-notification extension that the source does not contain, so replacing it needs a decision that keeps that service.

## Work to do

- Name the supported install source for both plugins: a release tag (Git install with `--subdirectory`) or a clean checkout of the released commit, never a participant worktree or a sandbox copy.
- Add a check or a `doctor`-style report that names a Promptobus plugin installed from a worktree, a temporary directory or a commit other than the installed release.
- Decide where the owner-notification extension lives: in the observer source or as a separate plugin. Then the panel can be reinstalled from a release without losing it.
- Reinstall both plugins on the owner's BB from the chosen source and record the executing identities.

## Out of scope

- New panel features.
- BB approval eligibility for agent-origin commands (PB-384).

## Verification

- After reinstallation, `bb plugin list` shows each Promptobus plugin from the release source, and its executing build identity matches the release commit.
- The check reddens on a fixture install path inside `.claude/worktrees/` or a temporary directory.
