# PB-15 · Claude availability adapter

- **Order:** 50
- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-14

## Context

The Claude Code driver (`lib/driver-claude.js`) starts a participant but knows nothing about whether the account can run the requested model right now. The plan asks for: binary and version, a non-interactive auth check, a mapping of runtime aliases to catalog ids, an honest `unknown` for the remaining limit when no stable source exists, and classification of late-start limit errors.

## Work to do

- Binary via the host's `resolveToolBin('claude')`; version from the binary; missing → `unavailable` / `binary_missing`.
- Auth: find the non-interactive check the binary offers today and measure it (record the command and its output shape in the task result); none → `unknown` / `not_authenticated` is wrong, use `quota_unknown` with a message that says auth could not be verified.
- Inventory: map aliases the driver accepts (`opus`, `sonnet`, the `DEFAULT_MODEL` constant) to catalog tuple ids; a model the binary lists that the catalog lacks becomes an `unrated` runtime row.
- Remaining limit: `unknown` unless the binary or its files expose a stable, documented source; never model an exact value.
- Late-start: the driver's start path recognises limit refusals in the harness output and reports them to the cache (PB-14 hook).

## Evidence from the catalog track's inventory (2026-09-05, `claude` 2.1.251)

- There is no non-interactive model listing: `claude --help` has no `models` subcommand and no `--list-models` (`claude --list-models` → `error: unknown option`, exit 1). Do not run `claude models` / `claude model list` as a probe: an unknown word is taken as a prompt and starts a turn.
- The only model names the binary publishes are in the `--model` help text (aliases `fable`, `opus`, `sonnet`, full names like `claude-fable-5`); effort levels come from `claude --effort <level>` help (low, medium, high, xhigh, max; `ultracode` is driver-only). Inventory therefore rests on the driver's alias set plus `DEFAULT_MODEL`, not on a listing.

## Out of scope

- Cursor and Codex — PB-16, PB-17.
- Any change to how the participant is lifted once available.

## Verification

- Adapter tests on stubbed binary output for each state; a live probe on the owner's machine recorded in the result with the command used.
- Mutation probe: change the alias map, the inventory test goes red.
