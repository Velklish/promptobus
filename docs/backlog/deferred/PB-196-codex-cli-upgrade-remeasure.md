# PB-196 · Eight minor versions behind: the upgrade is a measurable event, not a background chore

- **Scope:** [drivers](../../reference/05-drivers.md), [cli](../../reference/03-cli.md)
- **Created:** 2026-09-12
- **Dependencies:** none. Blocks PB-194, PB-191, PB-185 and PB-214: all four were measured on 0.146.0, and a fix written against that boundary is wasted if the upgrade moves it
- **Cost:** major

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

## Deferred

- **Deferred:** 2026-09-16
- **Reason:** Owner decision of 2026-09-16: the Codex cluster (PB-196, PB-194, PB-191, PB-185, PB-214) is deferred as a whole. The current run lifts Claude Code participants only, and every card in the cluster needs live Codex turns on the binary that PB-196 would replace — a fix measured against the old boundary would be lost with the upgrade.
- **Return condition:** The owner opens a dedicated Codex run; this card goes first in it, before any other card of the cluster is re-taken.

## Re-triage, 2026-09-23

Checked on `39316bc2` from the repository root. **Cost `major`**: the fixture gate, gate 5 of 5, is red on the owner's machine in every run until this card re-measures, and the Codex protocol tests keep checking the 0.146.0 schemas while 0.156.1 is what lifts.

- The binary moved without this card. `codex --version` → exit 0, `codex-cli 0.156.1`; 0.146.0 is no longer installed. "Installed 0.146.0, 0.154.0 offered" in the Context is the state of 2026-09-12.
- `grep -n PROVEN_CODEX_VERSION lib/driver-codex.js` → exit 0: `37: … = '0.146.0'`, and the lift refusal `versionLess(tool.version, PROVEN_CODEX_VERSION)` at `:415` still admits anything newer.
- "Nothing needs changing for the upgrade to be allowed" now holds for the lift only. Since PB-242 the fixture gate compares by equality (`scripts/check-codex-schema.mjs:37`, `if (version === PROVEN_CODEX_VERSION)`): `npm run codex-schema` → exit 1, "codex 0.156.1 is installed, the fixtures were taken from 0.146.0". So `PROVEN_CODEX_VERSION` is a floor for the lift and a pin for the gate. The PB-245 and PB-247 results record the same red as "5 gates, 4 green" and attribute it to this card.
- `ls test/fixtures/codex-app-server/` → exit 0: one directory, `0.146.0`, 15 files.
- `skills/extraRoots/set` is not part of the surface: `git grep -n extraRoots` → exit 0, and the only hit is this card; skills reach a participant by the copy into `.codex/skills` (`lib/driver-codex.js:372-384`). `thread/resume` is not called: `git grep -n 'thread/resume' -- lib src bin` → exit 1; `docs/reference/03-cli.md:996` names it as the recovery path. `thread/start` holds: `lib/codex-session.js:1219`.
- Stated as assumptions, because the card names no command for them: "an extra root does not survive the process", and the one-shot `400 invalid_request_error` refusal of 2026-09-12.
- **Return condition: not fired.** `git log --oneline --since=2026-09-16T00:00:00 -- lib/driver-codex.js lib/codex-session.js test/fixtures/codex-app-server` → exit 0, two comment-only commits (`5a7b306b`, `256e441e`), and no commit or card records a Codex run. Half of the deferral reason has expired: 0.146.0 is gone, so any Codex measurement now runs on 0.156.1. PB-246 (2026-09-23) keeps this card deferred and the fixtures with it. The return stays the owner's decision.
