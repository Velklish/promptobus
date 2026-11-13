# PB-320 · Four concurrent preflights lose an entry while none reports writing without the lock

- **Order:** 580
- **Scope:** [03. CLI § Availability](../../reference/03-cli.md#availability-the-adapter-the-preflight-and-the-cache)
- **Created:** 2026-10-03
- **Dependencies:** none
- **Cost:** minor

## Evidence

On 2026-10-03 an approver ran the repository gates three times on one tree (`63ae05ab`, docs-only on top of the PB-311 acceptance). The machine load average was 58–64 on 8 cores. The second run failed one test, `test/model-routing-preflight.test.mjs:823`, "four preflights writing at once all land, each with its own harness":

```
AssertionError [ERR_ASSERTION]: every writer took the lock and one still lost its entry to a neighbour that renamed second
actual [ 'alpha', 'delta', 'gamma' ], expected [ 'alpha', 'beta', 'delta', 'gamma' ]
```

The same file passed standalone twice on that tree and twice on `77d63620` (38/38 each), and the third full run passed 111/111 files. PB-311 does not touch `lib/model-routing/` or this test.

This is not a time budget. The test permits a lost entry only when some writer printed the `WITHOUT the lock` warning (`lib/model-routing/preflight.js:233`). In this run no writer printed it, so the test read the loss as silent.

Two explanations, neither verified:

- **The test.** The test collects each child's stderr in `data` handlers and resolves on `exit` (`test/model-routing-preflight.test.mjs:809`). Node documents that the stdio streams of a child can still be open when `exit` fires. Under load the fallthrough warning can then arrive after the assertion, and an allowed, reported loss reads as a silent one.
- **The product.** The cache lock in `lib/model-routing/cache.js` (`LOCK_WAIT_MS` 2000) has a window in which an entry is lost although every writer took the lock.

Evidence: Measured by the approver who filed it, 2026-10-03: one loaded full gate run on 63ae05ab (load 58–64 on 8 cores) failed test/model-routing-preflight.test.mjs, 'every writer took the lock and one still lost its entry', with no WITHOUT the lock warning; the file passed standalone twice on 63ae05ab and twice on 77d63620 (38/38), and the next full run passed 111/111. Checked at triage on 724c46af: the test resolves each writer on 'exit' (test/model-routing-preflight.test.mjs:809) and asserts at :823; the warning is lib/model-routing/preflight.js:233.

## Original work to do

- Wait for `close` instead of `exit` in this test, then reproduce under load (the four writers with a CPU hog beside them) until a run either reports the fallthrough or loses an entry silently.
- If the loss is silent with complete stderr, find the window in the cache lock and close it, or document it in the reference.

## Original out of scope

- Other load-sensitive tests of the same day: `lead-lifecycle.test.mjs`, `promptobus-e2e`, `codex-holder-spawn.test.mjs`.

## Original verification

- A loaded reproduction that shows which explanation holds, with the commands and exit codes.
- `npm test` and the repository gates exit 0.

## Context

Promote the original Cost: minor concurrency finding. The historical loaded run lost beta while no lock-fallthrough warning had been collected. The current test still resolves children on exit, which may precede stderr close; neither a capture race nor a product cache-lock defect has been proved. Preserve the complete historical assertion, load and standalone/base comparisons.

## Work to do

- Change only this concurrent-preflight fixture to wait for child close with complete stderr collection, preserving code/signal and every writer result.
- Run a bounded loaded four-writer reproduction with CPU contention and retain complete stderr, entry sets and timing. Classify an allowed warned fallthrough separately from a silent lost entry after complete capture.
- If silent loss remains, identify the actual cache-lock/rename window and minimally correct it, or explicitly document the supported limitation in the reference with its evidence. Do not declare the lock defective from the old incomplete capture.
- Add a deterministic fixture or mutation that proves the selected capture/lock correction; keep the original historical red unresolved until the evidence supports a disposition.

## Acceptance criteria

- The assertion runs only after every child and its stderr stream have closed; deliberately late stderr cannot be mistaken for absence of the warning.
- A loaded reproduction records whether warned fallthrough or silent loss occurred. A no-reproduction outcome names its bounded attempts and does not claim the historical cause is fixed.
- If every writer obtains the lock, all four entries remain; any permitted fallback is reported truthfully under the documented contract.

## Out of scope

- The other historical load-sensitive lead-lifecycle, promptobus-e2e and codex-holder-spawn findings; blanket timeout increases, sleeps or an unrelated cache redesign.

## Verification

- Retain exact loaded commands, source SHA, load/resource bound, per-child code/signal/stderr, cache entries and terminal exits.
- After any change run npm run build and node test/model-routing-preflight.test.mjs; run npm test and configured repository gates on the final source. Proposed checks are notRun.
- For any red, retain its exact assertion and repeat the named test twice plus the exact-base comparison before attributing it.

## Next step

Execute the bounded investigation in queue order; retain the original evidence and hypothesis label and satisfy the stated execution prerequisites before implementation or live work.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
