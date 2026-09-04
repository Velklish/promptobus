# ADR-002: Standalone host and the host contract

**Status:** Accepted
**Date:** 2026-09-04
**Deciders:** not established; recorded from the shipped host contract

## Context

The bus starts sessions, delivers mail, and keeps an on-disk task. It does not own a workspace layout: where clones live, which tools a site declared, how a repository name is resolved, or whether an older store still exists.

Those answers belong to the product that embeds the bus. If the bus learned them from a global object or from paths baked into its own tree, a second product could not host it, and two hosts in one process would share state.

The standalone CLI still has to run without any embedding product. It needs a host that can be built from the current directory, Git, and an optional `promptobus.json`.

## Options

1. **Bake a workspace layout into the bus.** Cheapest for one product. The bus then cannot ship as its own package: every path and tool name becomes part of its public surface.
2. **Process-wide singleton host.** One assignment at startup. Two hosts in one process stop being independent, and tests have to mutate global state.
3. **`PromptobusHost` passed on every call.** The caller names the workspace for that call. Two hosts in one process stay independent. The standalone CLI builds one host and passes it in.

## Decision

The bus does not know the workspace. Knowledge of the workspace lives behind `PromptobusHost` (`src/host.ts`). The caller passes a host into every CLI entry, library helper, and hook planner that needs one. There is no process-wide singleton.

`PromptobusHost` answers workspace questions: command name and version, workspace root and store home, tool list, skill and plugin paths, MCP servers for a participant, repository resolve, freshness, extra environment, and how to format commands. Field names describe a workspace in general, not one product's directories.

The standalone host (`src/standalone.ts`, `createStandaloneHost`) builds that object from `cwd`, Git, and `promptobus.json`. It does not search another product's tree and does not invent remote namespaces. `legacyLayout()` on that host returns `null`.

`legacyLayout() === null` is a declared state, not a crash. It means this workspace has no former store to migrate. Callers that omit the host are rejected: absence of a legacy store is something the host must say, not something a missing argument can imply (`lib/store.js`, `src/migrate.ts`).

## Consequences

- A second product hosts the bus by implementing `PromptobusHost`. It does not fork the bus to change paths.
- Tests and adapters may construct two hosts in one process. Nothing hidden in module scope joins them.
- The standalone CLI is one host among others. Its empty legacy layout is as valid as a host that points at an old store.
- Migration code must take `legacyLayout()` from the host. It must not guess a previous directory.
- New workspace facts go on the host, not into core or driver files.
