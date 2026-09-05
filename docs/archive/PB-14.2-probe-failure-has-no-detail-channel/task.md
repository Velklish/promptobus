# PB-14.2 · A failed probe tells the person nothing about why it failed

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-14

## Context

PB-14 decided that a thrown adapter error contributes no text to the snapshot: `failedVerdict` in `lib/model-routing/preflight.js` writes `the adapter did not answer the contract (threw Error)` and discards the error's message. The reason is real and holds — an adapter written as `throw new Error(stderr)` would put harness output into the one free-text field that reaches a `0600` cache file, and the suite proves it does not (`test/model-routing-preflight.test.mjs`, the throwing stub throws with a fake token in its message and the token is absent from the written file).

The cost is that a person whose harness will not probe sees the same eleven words whatever went wrong. The verdict's `message` is the only free-text field there is, and everything in the returned snapshot is also what gets written, so there is no channel today that is diagnostic-only.

This is a gap, not a defect: PB-14 shipped the safe half deliberately. It matters to PB-15…PB-17, which write the adapters that will fail in the field, and to PB-21, which owns what `models` prints.

## Work to do

- Decide whether a detail channel is wanted, and where. Two shapes worth weighing, and neither has been prototyped:
  - the adapters carry their own diagnosis — an adapter that catches its own error and ANSWERS with a `probe_failed` verdict controls exactly what text travels, which is what the contract already asks for. This needs no mechanism at all, only the three adapter tasks doing it;
  - the preflight returns a per-harness detail that is never written to the cache — a second field on the returned snapshot only. That means the snapshot the resolver reads and the snapshot on disk stop being the same document, which is a contract change and needs the owner.
- Whichever is chosen, `docs/reference/03-cli.md` gains the rule so an adapter author reads it before writing a `throw`.

## Out of scope

- Relaxing the no-secrets rule for the cache file. The projection and the `0600` are gates in PB-14 and stay.

## Verification

- A person can tell a missing binary from a broken one from a harness that changed its output format, without reading source.
- The existing leak checks stay green: the fake token must remain absent from the written cache by both routes (attached to the verdict, and thrown inside an error).
