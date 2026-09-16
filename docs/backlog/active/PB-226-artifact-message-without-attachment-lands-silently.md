# PB-226 · A type=artifact message with no artifactPath is accepted and delivered without an attachment

- **Scope:** `src/mcp/tools.ts` (`promptobus_send` input), `src/v1/engine.ts` (`send`, the `input.artifact` branch), [04-protocol](../../reference/04-protocol.md) § Artifacts
- **Created:** 2026-09-16
- **Dependencies:** none
- **Taken:** 2026-09-17

## Context

Run of 2026-09-16, 17:27 UTC. An approver called `promptobus_send` with
`type: "artifact"`, a body describing a gate record, and the file under a wrong key
(`artifact`, then `artifactName`, instead of `artifactPath`). The bus accepted the call and
delivered a `type=artifact` message with a body and no file; nothing landed in the task
files folder. The sender noticed only by re-reading the folder and sent the file again; the
recipient could not tell a missing attachment from a described one, because the message
type said "artifact" either way. A less careful sender would have reported "record
attached", and the record would not have existed.

> Source: 2026-09-16, two consecutive `artifact` messages from the same address in the task
> journal — the first without an attachment, the second with `gates-approver-t4.json`; the
> sender's own account of the wrong key.

## Work to do

- `type: "artifact"` requires `artifactPath` at the tool boundary; the refusal names the
  parameter.
- Unknown top-level keys on `promptobus_send` are refused, not dropped: a misspelt key is
  the whole defect here.
- The protocol reference says an artifact message always carries a file.

## Out of scope

- Validating the attached file's content — `PB-217` (gate-record schema) and the handover
  record own that.

## Verification

- MCP test: `type: "artifact"` without `artifactPath` → refusal text names `artifactPath`;
  with an unknown key → refusal names the key. Mutation probe: drop the check → the message
  lands and exactly those assertions redden.
