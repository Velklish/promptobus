# PB-320 · Four concurrent preflights lose an entry while none reports writing without the lock

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

## Work to do

- Wait for `close` instead of `exit` in this test, then reproduce under load (the four writers with a CPU hog beside them) until a run either reports the fallthrough or loses an entry silently.
- If the loss is silent with complete stderr, find the window in the cache lock and close it, or document it in the reference.

## Out of scope

- Other load-sensitive tests of the same day: `lead-lifecycle.test.mjs`, `promptobus-e2e`, `codex-holder-spawn.test.mjs`.

## Verification

- A loaded reproduction that shows which explanation holds, with the commands and exit codes.
- `npm test` and the repository gates exit 0.
