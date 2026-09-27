# PB-300 · Align HostRoutingPaths scope and writable-layer behavior with the implementation

- **Order:** 500
- **Scope:** [02-host](../../reference/02-host.md)
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

The host reference describes workspace overlay state as account-scoped and says its writer is still unimplemented, contradicting both current code and earlier sections of the same document.

## Evidence

- At b3d4a387, docs/reference/02-host.md:426-430 says both HostRoutingPaths parts are account-scoped and do not derive from promptobusHome(). src/standalone.ts:179-185 puts the writable workspace overlay under home; cache/user overlay are account-scoped. The correct distinction is already at reference :189-191.

- Reference :377-380 calls models strategy --set future work and writable a declaration with no caller; :195,394-397 describe a future writer/warning. lib/models.js:455-511 implements the writer, writable-layer selection at :479-501 and shadow warning at :507-509.

## Work to do

- Describe cache/user overlay and workspace overlay with their actual independent scopes.
- Replace old future-tense writer descriptions with current selection, set/clear and shadow-warning behavior; remove task-history dependencies.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- The complete host reference defines one consistent HostRoutingPaths contract.
- In a disposable host configuration, models strategy --set/clear operates on the declared writable layer and produces the documented warning without changing a real account file.
