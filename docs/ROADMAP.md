# Roadmap

Where promptobus is going: goals and their rationale. This is a living document: a goal is direction, not a commitment; user signals determine priority and scope, not this list. Concrete tasks with statuses are in `npx github:Velklish/backslop#v0.4.0 status` and [backlog/](backlog/README.md).

## Goals

1. **Host-neutral bus.** A third party runs the CLI and embeds the library without another product's layout. The host contract in [adr-002-standalone-host-contract.md](adr/adr-002-standalone-host-contract.md) is the boundary. Evidence: `src/host.ts`, `src/standalone.ts`.
2. **Three harnesses in one CLI.** Claude Code, Cursor, and Codex share the same task store and the same MCP tools. Evidence: `lib/drivers.js`.
3. **Project-level hook installer.** A person opts in with `promptobus install --harnesses …`. npm `postinstall` does not edit harness files. Evidence: `promptobus help` lists `install` and `uninstall`; their flags are in [guides/install.md](guides/install.md).
4. **Routed model choice instead of a blind flag.** A person or an agent names an intent — a strategy — and the CLI picks the `role + harness + model + effort` tuple from a rated catalog intersected with what the local account can run right now, explains the pick, and never silently replaces an explicit `--harness`, `--model` or `--effort`. Evidence: the decision is [adr-003-model-routing.md](adr/adr-003-model-routing.md) and it is shipped whole — `models/catalog.json` (19 rated tuples), the four contracts in `schemas/model-routing/`, the libraries in `lib/model-routing/` (catalog and overlay merge, validate, preflight, cache, resolver, render, one availability adapter per harness), the host side `routingPaths()` in `src/host.ts`, and the pick of a routed lift in the participant's `metadata.routing`, printed per participant by `promptobus status`. Measured on 2026-09-05 with all three accounts logged in: one `promptobus models --refresh` probed the three harnesses in 2.6 s and chose `codex-luna-medium` at 73.10, naming every one of the 19 candidates with its score components or its exclusion reason.
5. **English runtime output.** New strings are English, and the Russian literals inherited from the transferred code are gone from what runs and from what ships. Evidence: `grep -rlP '[\x{0400}-\x{04FF}]' bin/ lib/ src/ schemas/ templates/` reports only `src/protocol.ts`'s Cyrillic-to-Latin transliteration table and `templates/bus-hook.mjs`'s address-prefix regex (it accepts `воркер`/`ревьюер` alongside `worker`/`reviewer` so a person typing in either language still gets the prefix stripped) — both functional data, not output text.

## Prioritisation principle

A live break or a missing command that a published guide already names comes first. Owner requests next. The backlog order field is the queue, not this list.
