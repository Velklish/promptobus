# ADR-034 · Deliver full Host context and classified canonical calls through the BB host entry

**Status:** Accepted
**Date:** 2026-10-08

## Context

SDK 0.6.15 selects only a plugin's own native tools and manifest skills. It has
no universal external MCP injection contract. Its dynamic instructions field is
bounded to 4096 characters. A new BB environment exists only after preparation;
collecting from the requested path or copying the owner's context would use the
wrong repository rules.

## Decision

The exported `promptobus/bb-host` integration collects the consumer Host's ordered
rule files and complete canonical skill text. The initial assignment carries that
context after preparation of the actual environment. Optional consumer preparation
runs the consumer's source generator before collection; it does not edit generated
adapters. Rules retain the Host's highest-precedence-first order.

The plugin supplies two native tools for context/resource reads and canonical
calls. SDK thread/project checks and canonical engine checks authenticate each
call. The model supplies only server/tool/arguments; role, environment and actor
come from the binding. The consumer owns transport and server configuration.
For constrained roles, fresh complete Host write classification and explicit
catalog access labels must agree; missing adapters or classification refuse
rather than dropping declared tools. Writes are refused before consumer dispatch.
Native reviewer MCP, Apps, shell and source edits remain disabled.

A source generator creates the canonical plugin variant with a consumer-owned
source integration module and an explicit package dependency. Generated output
is never edited or overwritten. The default plugin uses the standalone Host;
it refuses canonical servers until the consumer provides their adapter.

## Consequences

Full text does not depend on BB's short dynamic instructions or ignored adapter
output. The Host defines repo/module/base discovery, generator setup, canonical
resource roots and transport. Consumers keep private configuration outside this
repository and validate canonical tool argument schemas in their adapter.

Canonical resource reads are bounded; rule/skill text is limited to 256 KiB per
file and context to 1 MiB. Tool calls recollect admission for every invocation.
A live native session's tool inventory is fixed: changing Host context or plugin
source requires new participants, not an assumption that reload mutates existing
Codex sessions. The complete role workflow still requires its own evidence.
