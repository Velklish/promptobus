# PB-1.1 · The group-address refusal names a `clone` subcommand the package does not have

- **Scope:** [reference/03](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none
- **Taken:** 2026-09-05

## Context

Found while closing PB-1 and writing the gate its verification asks for.

`lib/spawn.js:537` builds the remedy for a repository query that resolved to a group out of `host.formatNpx(['clone', repo])`. Under the standalone host that renders `npx promptobus clone <group>`, and there is no `clone` subcommand: the dispatcher in `lib/cli.js` has `case` labels for `spawn`, `review`, `models`, `status`, `done`, `dismiss`, `history`, `prune`, `guard`, `warden`, `mcp`, `install`, `uninstall` and nothing else. Same shape as PB-1, same origin — a command inherited from the project this package was extracted from.

It is not a live failure today, and the distinction matters for whoever takes it. The branch fires only when `host.resolveRepo()` returns `group: true`, and the standalone host never sets that field (`src/standalone.ts:214` returns `{ nsPath, abs, via }`). So the wrong text can only be produced by a consumer host — and a consumer host that has group addresses usually does have a `clone` command, which is exactly what `formatNpx` is for. The bug is latent: the first host that grows group addresses without a `clone` command gets PB-1 again, in a second place.

The gate added for PB-1 (`test/cli.test.mjs`, “no message names a command the CLI does not have”) carries `clone` as its single named exception, pointing at this entry. The exception goes when this is decided.

## Work to do

- Decide which is true: the group hint is a consumer command and the package is right to defer to the host, or the package must not print a command it cannot name.
- If the first: the gate exception stays and gets its reason written next to it rather than a task link.
- If the second: word the branch without a command, the way PB-1's message now is — or give the host a hint method for it, next to `cloneHint(nsPath)`, which today answers only about a single repository.

## Out of scope

- The group-address feature itself. Standalone has none, and this entry does not ask for one.

## Verification

- `test/cli.test.mjs` needs no exception list, or the one it has carries a reason rather than a pointer to an open task.
