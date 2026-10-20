# ADR-039: Task close fences new message publication

**Status:** Accepted
**Date:** 2026-10-20
**Deciders:** Maintainer-approved recovery plan

## Context

Send admission checked task activity before awaiting an artifact stream. A
deterministic held-stream fixture then closed the task and released the stream;
the admitted send still committed a new message. The prior contract did not
define whether close drained or fenced such sends.

Intent creation commits the complete message before canonical and inbox links.
Those committed fan-outs must remain recoverable after task close. Artifacts are
published before message intent: another send can adopt their metadata through
`linkArtifact`, so creation by the refused sender does not prove deletion rights.

## Options

- Draining admitted sends needs explicit in-flight ownership and a draining state
  before close can become terminal.
- A final activity check inside existing task serialization defines the boundary
  without new state or a lock across the stream.
- Removing published artifact records on refusal needs proof that no committed
  message or intent has adopted them. Private staging would move that publication
  boundary and change more of the artifact protocol.

## Decision

1. Before reserving a logical ID or committing an intent, reread task activity
   inside the existing task then message-commit locks. If close committed first,
   both send variants refuse with the existing typed `task-closed` error. Close
   uses the same task lock; there is no await between this check and intent commit.
2. A committed intent may finish fan-out or recover on a done task. Recipient
   placement, recovery and intent retirement receive no new activity check.
   Preserve messages and attachments even if assignment metadata publication
   fails after intent creation.
3. Keep already-public artifact metadata, blobs and adapter links on refusal.
   They can belong to another committed send or intent. Preserve existing
   deduplication, retention and failed-stream temporary-file cleanup. Do not add
   a generic rollback catch or private staging protocol for this barrier.

## Consequences

Uncommitted message publication and close have a defined order. Close does not
wait for an admitted artifact stream, and a refused send can leave published
artifact metadata without its own message. That record remains under normal
retention and can still be referenced by another committed message.

An ID reservation interrupted before intent remains a harmless gap. After intent,
correspondence stays recoverable even if close or a crash precedes fan-out.
Streaming and recipient links remain outside the short commit section. The task
close mark provides no physical Stop acknowledgement or external-call drain.
