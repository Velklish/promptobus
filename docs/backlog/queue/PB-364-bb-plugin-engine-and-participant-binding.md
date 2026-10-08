# PB-364 · Add a local BB plugin entry point with engine-backed tools and authenticated participants

- **Scope:** [Host](../../reference/02-host.md), [Protocol](../../reference/04-protocol.md)
- **Created:** 2026-10-08
- **Dependencies:** [PB-365 · Export portable role instruction renderers while preserving native harness behavior](../../archive/LOG.md#pb-365)
- **Cost:** —
- **Order:** 10

## Context

The v1 engine already separates typed task/message/artifact state from native session launch. The BB integration should retain that canonical store and expose native plugin tools. The BB server and a remote execution host are distinct processes; a server plugin must not assume its filesystem is the participant's cwd. Tool identity must come from an authoritative binding, because plugin metadata is writable by clients and agents.

Evidence: Source snapshot `9a2a758209802e0b9632aad958f862d15e2e4c30`: `src/v1/engine.ts:44-185` and `:193`, `src/host.ts`. BB SDK 0.6.15 `bundled-types/bb-plugin-sdk.d.ts:21672` provides authenticated tool thread context and `:21746` marks pluginMetadata untrusted; `bundled-types/bb-plugin-sdk-host.d.ts:60` defines the host entry. The analysis probe accepted an opaque BB sessionRef and typed mailbox ACK without a driver; no BB model session was launched.

## Work to do

- Create the smallest local single-host BB plugin/package entry point using exported Promptobus engine and role renderers; select its repository/package ownership explicitly.
- Execute filesystem engine operations on the coordinator host through the supported host entry/RPC boundary. Retain the v1 store and avoid an unnecessary schema migration.
- Register role-scoped native tools for typed send, mailbox peek/read and required protocol/artifact operations.
- Persist task/participant/role/thread/environment/host bindings in plugin-owned state; authorize using authenticated tool context, never caller-supplied from/address or pluginMetadata.
- Handle the initial-turn race: tools must wait for or refuse until the returned thread identity is authoritatively bound. Implement the binding-finalization path without granting provisional privileges.
- Keep native CLI/registry entry points unchanged; do not feed a BB thread through the process-oriented native spawn flow.

## Out of scope

- No full multi-host support, migration of canonical messages into BB chat history, or rewrite of all native Driver APIs.
- No privileged operation authorized by mutable metadata and no new process/MCP transport for bus calls inside BB.

## Verification

- Local plugin tools use the engine to persist typed messages and artifacts; peek leaves unread state and read acknowledges exactly the caller's mailbox.
- Forged metadata, task/address/from and cross-thread role requests are denied; a first tool call before binding finalization performs no privileged operation.
- Engine/host restart retains authoritative bindings; an orphan thread or task is detected and cannot silently acquire another participant's rights.
- Record an actual local BB tool turn and host-routing evidence, distinct from mock SDK/unit coverage.
