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
