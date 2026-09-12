# PB-186 · Four preflight writers race on rename and one loses its entry, and adding files to the pool raises the odds

- **Order:** 190
- **Scope:** `test/model-routing-preflight.test.mjs` (`four preflights writing at once all land, each
  with its own harness`), `lib/model-routing/preflight.js`
- **Created:** 2026-09-12
- **Dependencies:** related to `PB-159.1` (deferred), which excludes this test by name

## Context

Seen once during the release run of 2026-09-12, and reported with the whole evidence set a red
result is owed rather than called external.

```
test/model-routing-preflight.test.mjs:716
  four preflights writing at once all land, each with its own harness
assert at :753
  AssertionError [ERR_ASSERTION]: a writer lost its entry to a neighbour that renamed second
  expected ['alpha','beta','delta','gamma'], actual without 'alpha'
```

**The evidence, complete:**

- the file and the code it exercises are **byte-identical to the base**:
  `git diff --stat <base> HEAD -- test/model-routing-preflight.test.mjs lib/model-routing/` is empty;
- run alone on the same HEAD **twice in a row**: exit 0, `pass 35 fail 0`; exit 0, `pass 35 fail 0`;
- a second full `npm test` on the same tree: 57/57, not reproduced.

So it is not a regression of the change under test. **What it is, is a race in the test's own
subject**: four writers finishing with a rename, and the last rename winning over a neighbour's
entry. The assertion's own message says so.

**And the author names their own part in it rather than stopping at "external".** Two new test
files were added to the pool in the same pass (`mutation-probe`, `session-env`). The file sits in
the serial group, but the serial group does not protect it from other files sharing the machine.
The race is pre-existing; the probability of hitting it was raised by the addition. That is not
"external".

**Why it is not `PB-159.1`.** That card is deferred and covers a family of wall-clock budgets; it
excludes this test by name ("The preflight test itself — PB-159"). This assertion is not a budget:
it is four writers and a rename order.

## Work to do

- Decide whether the product permits a rename race between concurrent preflight writers, or
  whether the test models a concurrency the product never has. The answer changes which side is
  fixed.
- If the product permits it, the writer must not lose an entry to a neighbour — the test is right
  and the code is wrong.
- If the test models something impossible, say so in the test rather than making it wait longer:
  a sleep would hide the question instead of answering it.

## Out of scope

- The wall-clock budget family — `PB-159.1`.
- The thread-file read race fixed under `PB-184`; different subject, same run.

## Verification

- The test's verdict does not depend on what else shares the machine.
- Whichever side is fixed, the fix names which concurrency the product actually has.
