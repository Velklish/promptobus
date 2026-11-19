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

**Acknowledged review parts (owner decision, 2026-11-20).** The owner approved
one read-only exception to inbox-only delivery: the current task owner can
retrieve one already acknowledged numbered status from a BB reviewer in the same
task, by its retained canonical id. This grants neither discovery nor history
access to another role. Keep the full body and id on first read; rereading a
part does not certify report completeness, acceptance or renewed reviewer authority.

Source inspection of the private workspace consumer (installed version 0.108.0,
Promptobus 0.33.1; consumer checkout `f303b94e8b7e3e795d63906bcd5ce94b3e99d1f0`)
found a native mailbox server in the canonical catalog, but no adapter proving
that its session and mailbox authority derive from this BB recipient. The stock
CLI renders a preview; artifact provenance reads and the native observer dashboard
do not give a participant that authority. Optional consumer Host adapters may
differ. This finding is based on code, not a query to a participant journal.

The server reserves a pending participant, then requests an SDK thread. A
`message.dispatch` hook holds its first assignment until the returned thread is
verified, its opaque sessionRef is finalized on the host, and the binding becomes
ready. The plugin requests a hook recheck after committing that state. Native
tools independently refuse unbound/pending identities, including a manual Send
now bypass. A failed launch remains orphaned, with no automatic reassignment.
Launch intent is durable before the SDK request. Inspection may list threads
with the recorded attempt marker after a lost reply, but that mutable marker is
never an authorization credential or a reason to retry spawn automatically.

## Consequences

Canonical mail and artifacts remain available after a plugin/host reload. Tool
arguments cannot name a sender, task or address. Participant ids remain independent
of roles. Reporter tools omit send; initial routing passes through the task
orchestrator. The plugin CLI is a local machine-operator surface, not an agent
identity credential. Ordinary native tools use authenticated SDK context.

The task uses a stable existing coordinator on the primary local host. Participant
environment creation and preservation follow [ADR-031](adr-031-bb-environment-lifecycle.md),
including its preparation phase before an assignment is admitted. Wake and replay
follow [ADR-032](adr-032-bb-wake-recovery.md); catalog routing and complete role
workflows require their own adapters.
Reviewer bus writes affect its authenticated
task journal only; source edits, shell and unclassified external tools remain
mechanically unavailable. Unrelated threads receive no bus tools.
