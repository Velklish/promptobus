# PB-323 · The machine lease is a polling race, not a queue, and a killed waiter's file stays

- **Scope:** [03. CLI § Lease](../../reference/03-cli.md#lease)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major

## Context

`underLease` (`lib/lease.js:156`) tries to take the lock, and on a busy lock sleeps `retryMs` (`lib/lease.js:229`) and tries again. Whoever retries first after a release takes the lease, so time spent waiting does not order the grant. In run bs020 on 2026-10-03 up to six participants gated under the lease at once. At 14:05:10Z worker:pb311 took the lease while a participant of a consumer repository group had waited since 13:58:05Z, and a participant could be passed over more than once.

A waiter's file `waiters/<pid>.json` is removed in the `finally` of `underLease`. A process killed by a signal, or one whose session died, leaves it. `readLease` drops dead pids from what it prints (`lib/lease.js:107`), so the files only pile up. Source: 2026-10-04, `ls /tmp/promptobus-501/waiters` → 10 files, `kill -0` fails for every pid, the oldest `49831.json` from 2026-10-02 (task bs1002).

## Work to do

- Grant the lease in waiting order: the oldest live waiter by its `since` takes the next release, and a later waiter yields to it.
- Remove a dead waiter's file when the lease is read.
- Keep the wait bound, the refusal text and the holder line as they are.

## Out of scope

- The bound itself and its default.

## Verification

- A test with three waiters registered in order: the first registered takes the lease after the holder leaves, whatever the retry timing; it fails on the old loop.
- A waiter file whose pid is dead is gone after the next `lease` read; a test fails on the old code.
