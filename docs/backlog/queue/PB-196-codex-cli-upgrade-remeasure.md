# PB-196 · Eight minor versions behind: the upgrade is a measurable event, not a background chore

- **Order:** 17
- **Scope:** [drivers](../../reference/05-drivers.md), [cli](../../reference/03-cli.md)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Measured 2026-09-12. The installed binary is `codex-cli 0.146.0`, placed 2026-08-03; the package
manager offers `0.154.0`, and the registry's `latest` is the same. Eight minor versions and roughly
five and a half weeks separate them.

The version gate will not stand in the way: `PROVEN_CODEX_VERSION = '0.146.0'` and the refusal is
`versionLess(tool.version, PROVEN_CODEX_VERSION)`, so anything newer passes. Nothing needs changing
for the upgrade to be *allowed*.

What the upgrade does need is a list, because **every Codex fact this repository holds is stamped
`0.146.0`** and several of them are about behaviour that a release can silently change:

- the approval request the holder sees. `PB-191` is precisely about a generation of
  `item/fileChange/requestApproval` that carries no path, so containment fails closed. A newer CLI
  may carry the path — in which case the hole closes by itself and the card is answered by the
  upgrade rather than by code. That is a good outcome and still has to be *measured*, not assumed.
- the participant sandbox boundaries recorded in `PB-194`: worktree not writable from the shell,
  `$TMPDIR` writable, `listen` refused.
- the model inventory. `PB-187` records that `debug models` answers differently between calls
  seconds apart, and that its content diverges from `model/list`. Whether that survives the upgrade
  is unknown.
- the app-server surface the mechanism depends on — `skills/extraRoots/set`, `thread/start`,
  `thread/resume`, and the fact that an extra root does not survive the process.

A second, smaller finding of the same day belongs here: the owner's own default model is newer than
the installed binary can drive. A one-shot run refused with
`400 invalid_request_error: this model requires a newer version of Codex`, before any generation, so
no quota was spent. An explicit `-m <model the binary knows>` is the workaround today; whether the
upgrade removes the need for it is exactly the kind of thing this card should answer rather than
guess.

## Work to do

- Upgrade **outside a live run**. A cask upgrade removes the versioned directory the `codex` symlink
  points at: held processes survive on their open binary, but every participant lifted afterwards
  comes up on the new version, and a run with two binaries in it has no denominator left for
  set-difference on reds.
- Re-take the stamped measurements above on the new version and record both numbers with both
  versions beside them. Where a result changes, say which card it answers or reopens.
- Decide whether `PROVEN_CODEX_VERSION` moves. It is a floor, not a pin; moving it refuses older
  binaries, so it moves only once the new version is the one actually proven.
- Answer the default-model question with a run, not a reading.

## Out of scope

- Pinning the binary or shipping it. The mechanism resolves what is installed.
- The owner's personal configuration, which the mechanism does not write.

## Verification

- Both versions named in every re-taken measurement, with the command and its exit code.
- For each card listed above: closed by the upgrade, unchanged, or reopened — stated explicitly,
  with the evidence. "Not re-checked" is an acceptable answer only when written down as one.
