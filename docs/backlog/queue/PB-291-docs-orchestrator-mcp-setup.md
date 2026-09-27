# PB-291 · Make orchestrator MCP setup explicit for each supported harness

- **Order:** 410
- **Scope:** [02-host](../../reference/02-host.md), [Install](../../guides/install.md#3-mcp-server-for-the-orchestrator)
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

A new user is told to place one JSON snippet in an unnamed harness project MCP file. The supported harnesses do not all use the same file or syntax, and hook installation does not register the orchestrator MCP server.

## Evidence

- At b3d4a387, docs/guides/install.md:84-105, README.md:71-88 and README.ru.md:66-83 provide `mcpServers` JSON without per-harness destination filenames.

- lib/driver-codex.js:209-249 emits TOML `[mcp_servers.<name>]`, written to config.toml at :431. lib/driver-cursor.js:223,307 uses .cursor/mcp.json. This is an incompatible-format/documentation gap, not a claim that a live Codex config was changed or failed.

## Work to do

- Add exact project config destinations, valid minimal snippets, trust prerequisites and read-only verification steps for Claude Code, Cursor and Codex.
- Explain which setup step install performs and which is the user's MCP registration step; preserve documented identity limitations.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- Each snippet parses in its actual format and identifies PROMPTOBUS_HOME consistently.
- Following the guide in a disposable workspace for each supported harness requires no guessed filename or JSON-to-TOML translation; record live verification separately from syntax checks.
