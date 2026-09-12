# PB-198 · The live-participant ceiling is a penalty inside a chosen lane, not a gate before the harness is chosen

- **Order:** 19
- **Scope:** [drivers](../../reference/05-drivers.md), [cli](../../reference/03-cli.md)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Filed by the consumer of this package.

Under `balance`, the `liveParticipantPerHarness` penalty takes effect **inside a lane that has
already been chosen**: the count of live participants never removes a harness from the field before
the choice happens. So a harness already carrying its practical maximum keeps competing on score and
can win, and the penalty then adjusts an outcome that should not have been available.

The package's contract already anticipates the shape `caps.liveParticipants.<harness>`, but the
value and the rules for applying it are not part of the contract — today they would have to be
reconstructed from a single observation, which is exactly what a contract exists to prevent.

## Work to do

- Define and document a live-participant ceiling per harness, applied **before** the harness is
  chosen under `balance`.
- Keep the key separate per harness. Plans and capacity differ between them, so one number for all
  three is a number that is wrong for at least two.
- Fix what happens at the ceiling — refusal, or moving to the next candidate — and fix the shape
  `caps.liveParticipants.<harness>` in the protocol and in the schema.

## Out of scope

- The activity watchdog and elicitation for one harness; those are separate cards.
- Choosing the ceiling's numeric value for a particular consumer, and any re-pinning or
  documentation work on the consumer's side.

## Verification

- `caps.liveParticipants.<harness>` present in the overlay schema.
- Routing cases that exercise harness choice with the ceiling reached, one per harness, showing the
  harness is out of the field rather than merely penalised.
- A mutation probe aimed at the gate and not at the penalty: with the ceiling in place, raising it
  by one must bring the harness back into the field. A green probe here condemns the check.
