# PB-208.1 · Removing a blob races a publication path that takes no lock

- **Scope:** `lib/sweep.js` (`sweepArtifacts`), `src/v1/engine.ts` (`send`, `sendSync`), [04-protocol](../../reference/04-protocol.md) § Store layout
- **Created:** 2026-09-14
- **Dependencies:** PB-208
- **Taken:** 2026-09-16

## Context

`promptobus sweep` removes a blob of the piece it is clearing when nothing else names the
payload. It reads "nothing else" twice — the surviving artifact records, and the hard-link
count of the blob — and does both under the task journal lock. Neither reading covers a
sender that is mid-publication, because **publication does not take that lock**.

Confirmed by reading the engine rather than inferred from behaviour. The task lock is taken
by the journal writers and by nothing else: `addParticipant`, `putParticipant`,
`patchParticipant`, `claimOwner` and `closeTask` in `src/v1/store.ts`, and `patchTask` in
`src/v1/engine.ts`. `send` and `sendSync` take no lock at any point — they stash the blob,
link the `files/` entry through the adapter's callback, then write the metadata record:

<!-- quote:../../../src/v1/engine.ts -->
```ts
    sendSync(task, input) {
      const { sender, recipients, meta } = prepare(task, input);
      let artifact: ArtifactV1 | null = null;
      if (input.artifact) {
        const source = input.artifact;
```
<!-- /quote -->

So the surviving window is: a neighbour's `stashBlobSync` completes and finds the payload
already there (`EEXIST` is dedup), the sweep removes that blob because no record and no
second link names it yet, and the neighbour's `placeFile` and `writeArtifact` then land a
record whose payload is gone. The cost is one unreadable artifact; the message that carried
it survives, and the sender's own copy on disk is untouched.

The window is narrow — between one `linkSync` and the next call — and the two readings
already close the wider halves of it. It is recorded rather than fixed because closing it
means locking the publication path, which is a change to the hot path of every message send
and is outside the card that found it.

> Source: 2026-09-13, review of PB-208 and a read of `src/v1/engine.ts` and `src/v1/store.ts`.
> Not reproduced: the interleaving needs a sender stalled between two adjacent calls.

## Work to do

- Decide whether the publication path takes the task lock, or whether blob removal moves
  behind a mechanism of its own — a staged rename with a re-read, or a refcount the store
  maintains rather than the sweep computing one.
- Whichever is chosen, `sweep` and `prune` must read "nothing names this payload" the same
  way; two answers to that question is the defect this finding is one instance of.

## Out of scope

- The rest of PB-208: the verb, its gate, the keep list and the merge proof are closed.
- Blob removal at `prune`, which takes the whole task directory and has no live sender.

## Verification

- A stand that holds a sender between `stashBlobSync` and `writeArtifact` and runs a sweep
  of another participant's piece in that window: with the fix the blob survives, and the
  artifact reads back.
- The existing PB-208 check that a second hard link holds a blob stays green: whatever the
  fix is, it must not loosen the reading that already works.
