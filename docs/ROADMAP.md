# Roadmap

Where promptobus is going: goals and their rationale. This is a living document: a goal is direction, not a commitment; user signals determine priority and scope, not this list. Concrete tasks with statuses are in `npx github:Velklish/backslop#v0.3.0 status` and [backlog/](backlog/README.md).

## Goals

1. **Host-neutral bus.** A third party runs the CLI and embeds the library without another product's layout. The host contract in [adr-002-standalone-host-contract.md](adr/adr-002-standalone-host-contract.md) is the boundary. Evidence: `src/host.ts`, `src/standalone.ts`.
2. **Three harnesses in one CLI.** Claude Code, Cursor, and Codex share the same task store and the same MCP tools. Evidence: `lib/drivers.js`.
3. **Project-level hook installer.** A person opts in with `promptobus install --harnesses …`. npm `postinstall` does not edit harness files. Evidence: the command form in [guides/install.md](guides/install.md); the CLI in this tree does not yet register `install`.
4. **English runtime output.** New strings are English. Existing Russian literals in the transferred code are a later pass. Evidence: this documentation; `lib/cli.js` help is still Russian.

## Prioritisation principle

A live break or a missing command that a published guide already names comes first. Owner requests next. The backlog order field is the queue, not this list.
