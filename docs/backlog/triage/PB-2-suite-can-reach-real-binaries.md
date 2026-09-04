# PB-2 · The suite can execute a real user binary when a stub name is missed

- **Scope:** [reference/03](../../reference/03-cli.md)
- **Created:** 2026-09-04
- **Dependencies:** none

## Context

A driver test hung. The cause was not the test: `spawn` had launched the operator's own `~/.local/bin/cursor` with `mcp enable` and waited on it.

The chain is short and none of its links looks wrong on its own. The Cursor driver declares `options.tool = 'cursor'`. `spawn` resolves that through `host.resolveToolBin('cursor')`. The standalone host answers `{ ok: true, bin: 'cursor' }` — it does not search install directories, it hands back the name. `run('cursor')` then resolves through `PATH`, and `PATH` still contains the real machine. The harness stubbed only `agent`, the name the driver actually documents, so nothing intercepted `cursor`.

Sandboxing `HOME` and `TMPDIR` did not help, and could not: the binary was found through `PATH`, which the sandbox never touched.

Immediate repair was to stub all three names — `cursor`, `cursor-agent`, `agent`. That closes today's hole and leaves the shape of it open: any tool name a future driver declares, and any stub name someone forgets, reaches the real machine the same way. The suite is one missed name away from running whatever the operator has installed.

Nothing detectable was damaged this time: the personal Cursor config held four servers, none of them ours, with no sandbox or temporary paths inside it. That is luck about which subcommand ran, not a property of the suite.

## Work to do

- Make escape impossible rather than unlikely: run child processes with a `PATH` that contains only the stub directory, so an unstubbed name fails to resolve instead of finding the machine.
- Decide whether the Cursor driver's `options.tool` should say `agent`, the name of the binary it actually runs. Today the declared name and the real one differ, and the harness had to know both.

## Out of scope

- The live harness scripts. They are meant to touch real binaries and are never part of an automated run.

## Verification

- With the stub directory removed from a test's `PATH`, the spawn fails to resolve rather than launching anything from the machine.
- A test that asserts no process was started outside the stub directory during a full run.
