# PB-170 · A bus participant in Codex runs without hooks because the bypass flag is built after the subcommand, where it is rejected

- **Order:** 80
- **Scope:** `lib/codex-session.js` (the holder's argv), `lib/driver-codex.js` (`argv`),
  [03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Owner's decision of 2026-09-12: a participant must reach the bus **without a manual step**. Today
`spawn --harness codex` prints, on every lift:

```
hooks are unavailable to the participant (trustStatus: untrusted, app-server has no bypass flag)
```

The memory hook and the turn-guard hook therefore do not run for a Codex participant, and the
only way to trust them is `/hooks` in an interactive Codex session — a human step, on every
machine, for every person who installs the workspace.

**The second half of that line is true literally and false in its conclusion.** Measured on
codex-cli 0.146.0, 2026-09-12:

```
$ codex app-server --help | grep -ci bypass
0
$ codex --dangerously-bypass-hook-trust app-server --help; echo $?
[experimental] Run the app server or related tooling
0
$ codex app-server --dangerously-bypass-hook-trust --help; echo $?
error: unexpected argument '--dangerously-bypass-hook-trust' found
2
```

The flag is **global**: accepted before the subcommand, rejected after it. `app-server`'s own
option list does not carry it, which is what the message reports — but the invocation can carry
it all the same. Its help text addresses exactly this case: "Run enabled hooks without requiring
persisted hook trust for this invocation. DANGEROUS. Intended only for automation that already
vets hook sources."

Both places that build the argv put `app-server` first, so there is nowhere for the flag to go
today:

- `lib/codex-session.js:987` — `spawn(record.bin, ['app-server', '--stdio'], …)`
- `lib/driver-codex.js:534` — `argv: ['app-server', '--stdio']`

## Work to do

- Put the flag ahead of the subcommand in both argv sites, for **bus participants only**.
- Keep the boundary explicit and documented: the mechanism vets the hook sources it writes
  itself, and that is what the flag's own help asks for. A person's own Codex sessions are not
  touched and still approve hooks through `/hooks` — that is a boundary, not an omission.
- Replace the lift line. "app-server has no bypass flag" must stop being printed: it is the
  sentence that closed this question for two days. What the line should say instead is whatever
  becomes true — hooks carried by the invocation, and which ones.
- A check that fails when the flag is built after the subcommand. Asserting that the array
  contains the string is not enough: the defect is entirely in the position, and a check blind
  to order would have passed on the broken form.

## Out of scope

- Hook trust for a person's own Codex sessions. No non-interactive approval command exists
  (checked against `--help`, 26 subcommands), and the mechanism does not speak for a human.
- The MCP per-call approval that kills bus calls — that is `PB-161.4`, a different question on
  the same "the participant has no person to ask" theme.

## Verification

- A lifted Codex participant runs the memory hook and the turn guard; shown by the hook events
  in the holder's journal, not by the absence of the warning.
- A check red on the flag built after the subcommand, green before it.
