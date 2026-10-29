# PB-411 · A gate record carries one dirty moment, not a guarantee that the tree stayed unchanged for the interval of the gate (owner decision on the contract)

- **Scope:** [reference/04-protocol § The gate record](../../reference/04-protocol.md#the-gate-record), `schemas/v1/gate-record.schema.json`, `schemas/v1/handover-record.schema.json`
- **Created:** 2026-10-29
- **Dependencies:** none; needs the owner's decision on the contract
- **Cost:** major

## Context

A consumer workspace's reconciliation of 2026-10-26 against Promptobus 0.29.0: the gate record schema accepts a single `dirty` boolean and rejects an unknown `dirtyDuring` field; a corrected schema fixture validates (exit 0). This is the limit of the form, not a new live demonstration of a dirty interval. A confirmed false certification of a live run was not reproduced.

`dirty` is "whether tracked files were modified when the command ran". It is taken at one moment, and a gate run takes an interval. A change made before the moment and undone before the end leaves an honest `dirty: false` about a tree that was dirty while the run went on. The record is accepted by the schema and read by a reviewer as proof of a clean run; it proves the cleanliness of one instant.

The handover record's `treeState` has the same gap: `beforeProbe` and `afterRestore` are two moments, and the form does not see a change between them. It is safer there, because both moments belong to the probe itself, but it is the same class.

Evidence:

- Source: 2026-10-29, `schemas/v1/gate-record.schema.json`, `$defs.record.properties.dirty` is `{"type": "boolean"}` with the description quoted above; `grep -rn dirtyDuring schemas lib test` prints nothing.
- Source: a consumer workspace's run of 2026-09-17: a full run waited for a repository-wide slot, and the worker made a mutation probe in the tree meanwhile; the gate run then started on a tree that had been dirty part of the interval and printed a clean tree at its end. The worker discarded the numbers and re-ran, so the record was never built. What `dirty` would have said was not measured; presumably `false`.

## Work to do

- The owner chooses the guarantee: the author of the run keeps the tree unchanged during the gate (the current implicit rule, stated in the reference), or the record carries the interval (for example a second `dirty` reading at the end of the command, or a field naming a change during the run).
- Implement the choice in both schemas and the reference, with a fixture that a record built over a dirty interval either is refused or carries the dirt in a field and does not say `dirty: false`.

## Out of scope

- The repository-wide full-run slot of a consumer; it only explains how the gap appeared.
- A change of the gate runner's own tree snapshot outside the record schemas.

## Verification

- A negative fixture: a gate record built over a run whose tree was dirty during the interval is refused at `send` or carries the dirt by field.
- The reference section states the chosen guarantee, and a test fails on the old text.

## Deferred

- **Deferred:** 2026-10-29
- **Reason:** the record form is a contract; the choice between a stated author's guarantee and an interval field in the schemas is the owner's, and none of the candidates is measured. Until then the author of a run keeps the tree unchanged, and two clean status readings mark only its ends.
- **Return condition:** the owner chooses the interval guarantee, or a confirmed case appears where a record said `dirty: false` for a run over a dirty interval.
