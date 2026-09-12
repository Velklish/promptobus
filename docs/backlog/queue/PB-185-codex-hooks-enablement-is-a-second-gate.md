# PB-185 · Trust is not the only gate on a Codex hook: the flag speaks of *enabled* hooks, and enablement is unmeasured

- **Order:** 30
- **Scope:** `lib/driver-codex.js`, `lib/codex-session.js` (the participant's home),
  [hooks-and-trust](../../guides/hooks-and-trust.md)
- **Created:** 2026-09-12
- **Dependencies:** `PB-189` (a lift does not record the copy that ran, which is what blocks the firing measurement)

## Context

`PB-180` put the participant's hook file into its own working directory — the one directory a
Codex participant trusts, written into its home as
`[projects."<realpath>"] trust_level = "trusted"` by the lift. A live paid turn then measured
whether that is where Codex looks. It is not enough:

```
grep -c "hook/started" <holder journal>   → 0
```

and the zero is not "nothing happened": the turn ran end to end — 45 journal lines,
`turn/started`, three `item/started` and three `item/completed`, `turn` to the end, `LIVE_EXIT=0`
— with **no `hook/*` event of any kind**. The file was on disk at 1062 bytes, carrying `Stop` and
`SessionStart` with the participant's own identity flags (`--role reviewer:… --task … --home …`),
and its directory was trusted. Reading the workspace root's file instead is also excluded: no
`--role` appeared anywhere.

**What the turn does not distinguish, and why that is the card.** `codex --help`:

> `--dangerously-bypass-hook-trust` — Run **enabled** hooks without requiring persisted hook trust
> for this invocation.

Trust is one gate; **enablement is another**, and nothing here measured it. Beside it in the CLI
sit `codex plugin` and `--enable <FEATURE>` (`features.<name>=true`), and the participant's home
carries a `plugins/` directory. So "the place is wrong" and "the place is right and the hooks are
not enabled" both fit the evidence, and neither may be asserted.

One more fact from the same measurement: **the participant's home contains no `hooks.json` at
all** — `auth.json`, `config.toml`, `plugins/`, `skills/` and caches, nothing else.

## Work to do

- Establish what enables a hook for a Codex session, and whether a participant can be given it
  without a person. Read what is readable first — `codex plugin`, the feature flags, the home's
  `plugins/` — and spend a live turn only on what reading cannot settle.
- Depending on the answer, either enable the hooks the participant already has, or move the file
  to wherever enablement expects it, and say which by measurement.
- If a participant cannot have hooks without a person, record that as a boundary of the contract
  rather than as an open defect — it is the same shape as `/hooks` for a person's own sessions.

## Out of scope

- The write into the working directory, which `PB-180` made and which stays: removing it would
  undo work that is correct if the gate turns out to be enablement.
- Hook trust — `PB-170` settled it and the flag stays.

## Verification

- A statement about why a participant's hooks do not run that rests on a measurement rather than
  on the absence of an alternative.
- If they can run: `hook/started` in the holder's journal, with the participant's own `--role`.

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

**Follow-up live measurement, 2026-09-12.** The installed Promptobus copy was 0.7.0 and three
independent Codex holders ran two turns each. Every holder journal had `turn/started=2` and
`hook/started=0`. The live processes carried `/opt/homebrew/bin/codex --dangerously-bypass-hook-trust
app-server --stdio`, so the installed-copy precondition is now satisfied. The installed
`lib/codex-hold.js` nevertheless gave `grep -c PARTICIPANT_ARGV` = 0: the flag arrived through a
different route, and the proposed marker cannot attribute that route.

The readable enablement state was positive. On the participant home, `codex features list` exited
0 with `hooks stable true`, `plugins stable true`, and `plugin_hooks removed false`; both
`codex --enable hooks features list` and `codex -c features.hooks=true features list` returned the
same feature state. `codex plugin list --json` returned empty `installed` and `available` lists,
and the home's `plugins/` held only staging and cache directories, not an installed plugin. The
worktree had 59 `.codex/skills` entries and `.codex/hooks.json`, so the skills channel exists too.
No enablement write or hook relocation was made because the feature readout was already enabled.

What remains open is deliberately narrower: the six-turn run produced no hook event, and the
feature readout describes home configuration rather than the session's effective state. The
reason for silent hooks is not established; no human-only boundary was measured, and this card
stays open for that cause rather than being archived.

## PB-180 merged into this card, 2026-09-12

`PB-180` asked where a participant's hooks belong and answered its own question in its own
measurement: the place is the participant's working directory, the binary names that directory in
its refusal, and the mechanism already writes the project-trust entry
(`lib/driver-codex.js`, `trusted: [trustPath(workdir)]`, keyed by realpath). Both cards then stood
on one unclosed fact — `hook/started` = 0 with no `hook/*` event of any kind — and carried the same
"Measured 2026-09-12" section word for word. One cause, one card.

**What PB-180 contributes and is not lost:**

- The write into the participant's working directory **stays**. It is correct if the remaining gate
  turns out to be enablement, and removing it would undo work that measurement supports.
- Whatever is chosen must hold for a **reviewer as well as a worker** — their working directories
  differ, and a fix reaching only the worker leaves half the contract.
- The verification is the **holder's journal**, not the absence of a warning: a participant that
  runs hooks produces `hook/started`, and a check that passes without one measures nothing.
- Hook trust itself is settled by `PB-170` and the bypass flag stays. Hooks for a person's own Codex
  sessions are approved through `/hooks`; that boundary does not move.
