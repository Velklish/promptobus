# PB-301 · Document live-task sweep as an artifact-blob retention boundary

- **Order:** 510
- **Scope:** [04-protocol](../../reference/04-protocol.md)
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

The protocol reference conflates blob immutability with retention and promises that a payload lives until task pruning, despite live-task cleanup already removing unreferenced blobs.

## Evidence

- At b3d4a387, docs/reference/04-protocol.md:408-411 says immutable blobs are removed only with the task through prune.

- lib/sweep.js:149-174 removes accepted sender records/files; :169-171 removes a blob once blobNamed finds no surviving references. This occurs inside an active task; protocol reference :162 already describes the exception.

## Work to do

- Separate immutable content/deduplication from retention and document both whole-task prune and live-task sweep.
- Explain the surviving-reference condition and link the protocol contract to current CLI cleanup behavior.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- No unconditional prune-only retention promise remains in the current artifact documentation.
- The description matches existing sweep tests for unreferenced and still-referenced blobs; no runtime deletion policy changes.
