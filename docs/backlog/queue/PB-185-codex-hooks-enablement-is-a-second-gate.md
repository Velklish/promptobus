# PB-185 · Trust is not the only gate on a Codex hook: the flag speaks of *enabled* hooks, and enablement is unmeasured

- **Order:** 12
- **Scope:** `lib/driver-codex.js`, `lib/codex-session.js` (the participant's home),
  [hooks-and-trust](../../guides/hooks-and-trust.md)
- **Created:** 2026-09-12
- **Dependencies:** `PB-180` (closed on the boundary this card names)

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
