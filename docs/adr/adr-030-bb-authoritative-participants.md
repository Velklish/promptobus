# ADR-030: BB participants are plugin-bound; the host engine remains canonical

**Status:** Accepted
**Date:** 2026-10-08
**Deciders:** Repository owner (local BB integration scope); implementation: Codex

## Context

The BB server and execution host are separate processes. SDK 0.6.15 supplies
authenticated native-tool thread/project context, host RPC, plugin-owned SQLite
and a first-message admission hook. Its `pluginMetadata` is writable by clients
and agents. The exported v1 engine already owns typed tasks, mailboxes and blobs.

## Options

- Authorize from metadata: easy to render, but callers can manufacture an identity.
- Make BB messages canonical: duplicates existing engine journals and ACK rules.
- Persist identity in plugin storage and call the host engine: retains the store
  and separates server authorization from filesystem operations.

## Decision

The existing optional plugin package owns the adapter. Server SQLite stores a
unique task/participant and thread binding with role, project, environment, local
host, provider and canonical participant token. The host entry uses `openEngine`
and checks the canonical participant before any bound operation. No store schema
migration or native Driver session is introduced.

The server reserves a pending participant, then requests an SDK thread. A
`message.dispatch` hook holds its initial prompt until the returned thread is
verified, its opaque sessionRef is finalized on the host, and the binding becomes
ready. The plugin requests a hook recheck after committing that state. Native
tools independently refuse unbound/pending identities, including a manual Send
now bypass. A failed launch remains orphaned, with no automatic reassignment.

## Consequences

Canonical mail and artifacts remain available after a plugin/host reload. Tool
arguments cannot name a sender, task or address. Participant ids remain independent
of roles. Reporter tools omit send; initial routing passes through the task
orchestrator. The plugin CLI is a local machine-operator surface, not an agent
identity credential. Ordinary native tools use authenticated SDK context.

This entry point uses an existing environment on the primary local host. Managed
environment lifecycle, general wake delivery, catalog routing and complete role
workflows require their own adapters. Reviewer bus writes affect its authenticated
task journal only; source edits, shell and unclassified external tools remain
mechanically unavailable. Unrelated threads receive no bus tools.
