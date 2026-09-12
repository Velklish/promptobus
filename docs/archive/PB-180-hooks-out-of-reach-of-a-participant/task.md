# PB-180 · Project hooks live at the workspace root while a participant looks at its own sandbox, so a Codex participant runs none

- **Order:** 160
- **Scope:** `lib/install.js` (where hook files are written), `lib/driver-codex.js` /
  `lib/codex-session.js` (the participant's home and cwd),
  [03-cli](../../reference/03-cli.md) § The Codex holder,
  [hooks-and-trust](../../guides/hooks-and-trust.md)
- **Created:** 2026-09-12
- **Dependencies:** `PB-170` (closed by the same pass — this is what it did not reach)

## Context

Measured 2026-09-12 on a live Codex reviewer, in the same paid turn that proved the bus calls
now complete. `PB-170` removed the hook-trust blocker by putting
`--dangerously-bypass-hook-trust` ahead of the subcommand, and its verification asked for the
participant to run the memory hook and the turn guard. It does not:

```
grep -c "hook/started" <holder journal>   → 0
```

**The flag buys trust and nothing else.** The reason needs no guessing: `install` writes
`.codex/hooks.json` at the **workspace root**, the reviewer's cwd is its own sandbox, and the
participant's home carries only `[mcp_servers]` and `[projects]`. There are no hooks where the
participant looks, so there is nothing for trust to apply to.

**The lift line was corrected in the same pass**, and that matters as much as the measurement:
it had already been changed to say "hooks run for the participant", which would have been the
same offence as the `app-server has no bypass flag` line it replaced — a sentence closing a
question instead of a measurement. It now says trust is no longer the blocker and points at the
reference for whether a hook is there at all. The reviewer prompt's own "This harness has no
hooks" was left alone, because by this measurement it is true.

So `PB-170`'s change is **necessary and not sufficient**, and this card is the rest of it.

## Work to do

- Decide where a participant's hooks belong: written into the participant's own home beside its
  `config.toml`, or the participant pointed at the workspace root, or the hooks declared to it
  some third way. The decision is the card; the wiring follows it.
- Whatever is chosen must hold for a reviewer as well as a worker — their working directories
  differ, and a fix that only reaches the worker leaves half the contract.
- The verification must be the holder's journal, not the absence of a warning: a participant
  that runs hooks produces `hook/started`, and a check that passes without one is measuring
  nothing.

## Out of scope

- Hook trust itself — `PB-170` settled it, and the flag stays.
- Hooks for a person's own Codex sessions: those are approved by a human through `/hooks`, and
  that boundary does not move.

## Verification

- A lifted Codex participant's journal carries `hook/started` for the memory hook and the turn
  guard.
- The same holds for a reviewer, whose working directory is not a worktree.

## Measured 2026-09-12, and what the measurement moved

**Measured on codex-cli 0.146.0, no paid turn spent.** The place is right, and the binary said so
itself: with a `hooks.json` under `<cwd>/.codex` it refuses in stderr — `Project-local config,
hooks, and exec policies are disabled in the following folders until the project is trusted, but
skills still load. 1. <cwd>/.codex — To load project-local config, hooks, and exec policies, add
<cwd> as a trusted project in <CODEX_HOME>/config.toml.` It names the very directory this card
writes to. What the measurement also shows is that the enablement is **two independent gates, not
one**: `--dangerously-bypass-hook-trust` lifts trust in the HOOK, and what was refusing here is
trust in the PROJECT, recorded as `[projects."<realpath>"] trust_level = "trusted"` in the
participant's `CODEX_HOME/config.toml`. Adding that entry clears the refusal and the project-local
`.codex` loads. The mechanism already writes it — `lib/driver-codex.js`,
`trusted: [trustPath(workdir)]`, keyed by realpath — and wrote it before the merge too, so the
original `hook/started` = 0 was never about the project gate. Missing either gate produces the same
`hook/started` = 0, which is why a plan built on one door could not decide anything.

**What cannot be measured yet, and why.** Whether a hook actually fires once both gates are open
needs a turn: `hook/started` exists in this binary (it sits beside `turn/started` in the
notification set, and the holder logs every notification method), but it does not arrive on
`thread/start` even with the project trusted — the binary defers `SessionStart` hooks
(`run_pending_session_start_hooks`) until a turn, and there is no `thread/close`. So there is no
free observation of firing, and the paid one is blocked by something outside this card: **the bus
is run by the installed copy, not by this tree.** The live holders are
`node_modules/promptobus/lib/codex-hold.js` at version 0.6.0, which carries neither
`PARTICIPANT_ARGV` nor the bypass flag; `ps -eo args | grep -c dangerously-bypass-hook-trust` is
`0` across the live `app-server` processes. The firing measurement is therefore possible no earlier
than the installed copy becomes the merged one; until then a spent turn would repeat the earlier
inconclusive one. A precondition check on this class is now three parts, not two: the flag in the
live process's argv, the trust entry in the participant's `CODEX_HOME`, and the version and
`PARTICIPANT_ARGV` of the copy that raised that process — the last one asks whether the program
under test is the program that was fixed.
