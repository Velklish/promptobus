# PB-171 · The `env` of the bus record differs across three drivers, and what the harness does with it is measured for one

- **Order:** 90
- **Scope:** `lib/driver-claude.js`, `lib/driver-cursor.js`, `lib/driver-codex.js` (`mcpConfig`),
  `lib/spawn.js` (`participantMcp`), [contributing](../../guides/contributing.md) § What the
  stands prove, and what they cannot
- **Created:** 2026-09-12
- **Dependencies:** `PB-166.2` (closed by the same pass)

## Context

Found while closing `PB-166.2`, which fixed one driver. The measurement that follows says the
finding is about a shape, not about that one driver.

```
lib/driver-claude.js:717   function mcpConfig({ servers }) { return { mcpServers: { ...servers } }; }
lib/driver-cursor.js:335   function mcpConfig({ servers }) { return { mcpServers: { ...servers } }; }
lib/driver-codex.js:487    function mcpConfig({ servers }, ref, denyTools = []) { … env: { ...bus.env, ...extra } }
```

**The `env` key of the bus record exists in all three.** Claude and Cursor neither take `ref`
nor touch `env`; their record is the one `participantMcp` built (`lib/spawn.js:112-117`), with
`env: { PROMPTOBUS_ROLE, PROMPTOBUS_TASK, PROMPTOBUS_HOME }`. So "Codex composes an env while
the other two inherit" is the wrong shape of the statement: all three compose one, and two of
them compose a fixed set.

**Whether that is a hole is decided by the harness, not by the driver** — by whether it merges
the record's `env` over the inherited environment or replaces it with it.

- For **Codex it is measured live** (`PB-166.2`): the warden, whose parent is the participant's
  MCP server, carried neither warden name in its environment, though both stood on the lift
  command. That is a replacement, and it is what made the run-level gate blind.
- For **Claude Code and Cursor nothing is measured**, in either direction. A search for a
  record of it — code, `docs/`, the suite — found only statements about the environment of the
  lifted session itself, never about its MCP children.

**The stands cannot settle it**, and that is the reason the gate stayed silent in the first
place: a stand is a stub and lifts no MCP server at all. It takes a live lift on the real
binary, one paid turn per harness.

## Work to do

- Measure, on a live participant of each of the two harnesses, whether a name standing on the
  lift command reaches the process the participant's MCP server starts. Cursor on
  `grok-4.6` is the cheap side of that (owner's note, 2026-09-12).
- Where a harness replaces rather than merges, carry the warden switch and its trace the way
  `PB-166.2` carries them for Codex.
- Record the finding in the contributing guide's section on what the stands prove: a gate that
  can only see children of the command, and never children of a participant's MCP server, is
  bounded — and the boundary belongs in writing next to the gate.

## Out of scope

- `PB-166.2` itself: the Codex half is closed.
- Widening the run-level gate to cover stands. The gate is honest about processes it can see;
  the subject here is which processes those are.

## Verification

- For each of the three harnesses, the statement "a name on the lift command does / does not
  reach the participant's MCP child" rests on a live measurement, named in the card's result.
- A harness that replaces the environment carries the warden switch explicitly, with a check
  that fails when the carry is removed.
