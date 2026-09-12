# PB-166.2 · The warden switch and its trace do not reach a participant's MCP server, so the run-level gate cannot see a warden raised from there

- **Scope:** `lib/driver-codex.js` (`mcpConfig`), `test/run.mjs` (the auto-lift gate), `test/hygiene.mjs`, [contributing](../../guides/contributing.md) § Suite isolation
- **Created:** 2026-09-12
- **Dependencies:** none
- **Taken:** 2026-09-12

## Context

Found while building the PB-161.3 stand, not by looking for it. A real Codex reviewer was
lifted with `PROMPTOBUS_WARDEN=off` set on the `promptobus review` command, and a warden came
up anyway.

**Evidence, taken off the live processes.**

```
$ ps -eo pid,ppid,args | grep 'promptobus.js warden'
7662  7656  node …/bin/promptobus.js warden --task pb1613-marker-probe-t20260911-215740

$ ps -eo pid,ppid,args | grep 'promptobus.js mcp'
7656  7580  node …/bin/promptobus.js mcp

$ ps eww -o command= -p 7662 | tr ' ' '\n' | grep '^PROMPTOBUS_'
PROMPTOBUS_CODEX_SESSION=<home>/.promptobus/codex/sessions/review-…json
PROMPTOBUS_HOME=<home>/.claude/jobs/…/ws/.promptobus
```

So the warden's parent is the participant's **MCP server** (7656), and the warden's own
environment carries neither `PROMPTOBUS_WARDEN` nor `PROMPTOBUS_WARDEN_TRACE`. The switch was
set on the command that lifted the participant; it did not travel to the MCP server the
participant talks to, and the auto-lift point in that child therefore saw no switch.

The mechanism is visible in `mcpConfig` (driver-codex.js): the bus server entry is written as
`{ ...bus, env: { ...bus.env, ...extra } }`. The entry's `env` is composed, not inherited, so
whatever the lifting command had in its own environment does not reach that child unless it
is named in `extra`. Today `extra` carries the session file and, conditionally,
`PROMPTOBUS_CODEX_HOME`.

**What is and is not wrong here.** A real run WANTS a warden for a live participant, so this
is not a defect of production behaviour. What is wrong is the standing of the suite's gate.
The run-level auto-lift gate in `test/run.mjs` judges by `PROMPTOBUS_WARDEN_TRACE` — an
environment variable — and refuses a run in which any line was appended to it. Both halves of
that gate, the switch that prevents the lift and the trace that records it, travel only as far
as the environment does. A warden raised from a participant's MCP server would be invisible
to the gate **and** unstopped by the switch: the gate would be silent about exactly the
process class it exists to catch.

It is silent today for a benign reason, and that is the part worth writing down: the suite
never lifts a participant on a REAL harness binary. The Codex file does lift real holders —
`run.mjs`'s own holder gate exists because of it — but over a stub app-server, and a stub
starts no MCP server of its own. So no participant MCP server ever runs under the suite, and
the hole has no way to fire. The gate is green because the situation does not arise, not
because it is covered — and the day a check lifts a real participant, the gate's greenness
will mean nothing.

## Work to do

- Decide whether the two names belong in the composed MCP entry's `env`. If they do, they go
  in beside the session file in `mcpConfig`, and the Cursor and Claude drivers need the same
  question asked of them rather than assumed.
- Whichever way it goes, say it in `contributing.md` § Suite isolation, where the gate is
  described as "a run leaves no process behind": the gate's boundary is the environment, and
  a child that composes its own environment is outside it.
- A check is possible without a paid turn: the MCP server can be started directly with the
  composed entry's environment, and asked whether the two names are present. That measures
  the composition, which is the actual subject — the lift is not needed.

## Out of scope

- Whether a live participant SHOULD have a warden. It should; this card is about the suite's
  gate and about the switch meaning what it says.
- The orphan the warden itself becomes — it exits with its task, and the PB-161.3 stand's
  warden was stopped with the stand.

## Verification

- With the fix in place, a lift made with `PROMPTOBUS_WARDEN=off` raises no warden from a
  participant's MCP server, shown by `ps` on the live tree; or, if the decision is the other
  way, `contributing.md` names the boundary and the gate's description no longer reads as
  covering it.
