# PB-1 · Spawn error points at a tools subcommand that does not exist

- **Order:** 160
- **Scope:** [reference/03](../../reference/03-cli.md)
- **Created:** 2026-09-04
- **Dependencies:** none

## Context

`lib/spawn.js:291` builds a remedy for the operator out of `host.formatCommand(['tools', 'add', lifter.id])`. Rendered, that reads `promptobus tools add <harness>`. There is no `tools` subcommand: `lib/cli.js` handles `spawn`, `review`, `status`, `done`, `dismiss`, `history`, `prune`, `guard`, `warden` and `mcp`, and nothing else.

So the one message a user sees at the moment a harness is undeclared sends them to a command that does not exist. The failure is quiet in the worst way: the error itself looks helpful and complete.

The hint is a leftover from the parent project, where that subcommand does exist. Found while writing the public documentation; the writer could not document the command because it is not there.

## Work to do

- Decide which is true here: the bus owns a `tools` subcommand, or declaring a harness is a hand edit of `promptobus.json`.
- Make the message say the true one. If it stays a hand edit, name the file and the field rather than a command.

## Out of scope

- The `tools` allow-list itself and how spawn reads it. Only the remedy text is wrong, not the gate.
- Translating the message. The whole runtime is still Russian and moves in one wave.

## Verification

- Every command named in an error message resolves in `lib/cli.js`. Worth a test rather than a reading: extract command names from message strings and assert each is a known subcommand.
