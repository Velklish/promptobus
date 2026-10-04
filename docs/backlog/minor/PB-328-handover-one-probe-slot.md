# PB-328 · The handover record holds one mutation probe

- **Scope:** [04. Protocol § The handover record](../../reference/04-protocol.md#the-handover-record)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** minor

## Evidence

`checks.mutationProbe` in the handover record is one probe object or a not-run reason (`schemas/v1/handover-record.schema.json:42–44`, the object at `:108`). PB-318's worker ran five probes on `6a1b6599`: the artifact guard, the read that goes on after a failed drain, the forward, the drain call and the digest pairing. The record could carry one of them. The other four went into a prose evidence file, and the reviewer could check from the record only the one probe it held.

## Work to do

- Accept a list of probes in `checks.mutationProbe`, each validated as the single object is today, and keep a single object valid.
- Name every probe in the reviewer-facing checks that read the record.

## Out of scope

- How many probes a piece needs.

## Verification

- A record with two probes passes the door, and a record with one malformed probe in the list is refused by name; tests fail on the old schema.
- A record with one probe object, as written today, still passes.
