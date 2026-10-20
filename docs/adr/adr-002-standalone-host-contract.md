# ADR-002: Standalone host and the host contract

**Status:** Accepted
**Date:** 2026-09-04
**Deciders:** not established; recorded from the shipped host contract

## Context

The bus starts sessions, delivers mail, and keeps an on-disk task. It does not own a workspace layout: where clones live, which tools a site declared, how a repository name is resolved, or which former paths need an upgrade diagnostic.

Those answers belong to the product that embeds the bus. If the bus learned them from a global object or from paths baked into its own tree, a second product could not host it, and two hosts in one process would share state.

The standalone CLI still has to run without any embedding product. It needs a host that can be built from the current directory, Git, and an optional `promptobus.json`.

## Options

1. **Bake a workspace layout into the bus.** Cheapest for one product. The bus then cannot ship as its own package: every path and tool name becomes part of its public surface.
2. **Process-wide singleton host.** One assignment at startup. Two hosts in one process stop being independent, and tests have to mutate global state.
3. **`PromptobusHost` passed on every call.** The caller names the workspace for that call. Two hosts in one process stay independent. The standalone CLI builds one host and passes it in.

## Decision

The bus does not know the workspace. Knowledge of the workspace lives behind `PromptobusHost` (`src/host.ts`). The caller passes a host into every CLI entry, library helper, and hook planner that needs one. There is no process-wide singleton.

`PromptobusHost` answers workspace questions: command name and version, workspace root and store home, tool list, skill and plugin paths, MCP servers for a participant, repository resolve, freshness, extra environment, and how to format commands. Field names describe a workspace in general, not one product's directories.

The standalone host (`src/standalone.ts`, `createStandaloneHost`) builds that object from `cwd`, Git, and `promptobus.json`. It does not search another product's tree and does not invent remote namespaces.

The host contract has no former-layout member. The package no longer converts
former stores; the embedding product owns obsolete-path diagnostics and the
one-time upgrade route through the existing `v0.28.0` release. The current engine
refuses recognized old format and unfinished conversion before recovery or
creation; it does not infer product paths or mutate them. See
[Upgrading a former store](../reference/01-overview.md#upgrading-a-former-store).

## Consequences

- A second product hosts the bus by implementing `PromptobusHost`. It does not fork the bus to change paths.
- Tests and adapters may construct two hosts in one process. Nothing hidden in module scope joins them.
- The standalone CLI is one host among others; no host provides a migration implementation.
- Upgrade diagnostics name paths the embedding product owns. The package never guesses a product's former directory.
- New workspace facts go on the host, not into core or driver files.
