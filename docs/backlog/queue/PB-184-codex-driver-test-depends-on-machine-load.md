# PB-184 · `promptobus-driver-codex` reddens under load with different counters, so its result depends on the machine

- **Order:** 180
- **Scope:** `test/promptobus-driver-codex.test.mjs` (the `revThread.codexHome.config` assertions),
  [contributing](../../guides/contributing.md) § Suite isolation
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Observed 2026-09-12 during the release run, and reported with the evidence a red result is owed
rather than called external on the word of the author.

The file failed twice on `revThread.codexHome.config`, **with different counters each time** —
`126/140` and `136/139`. Both failures happened while three test runs shared the machine at
`load averages ≈ 40`. Re-run afterwards on the same code at `load ≈ 10`: **186/186 and 186/186,
exit 0**, and the base version of the file also **186/186**.

So the required evidence is in hand — the test is green on the author's change and green on the
base, twice each — and the difference between red and green is the machine, not the code.

**That is itself the defect.** A suite file whose verdict moves with the load of the host is not a
check of the product: it is green when the machine is idle and red when it is busy, and both
readings are uninformative about the change under test. The run worked around it by re-running,
which is exactly the habit that turns a real regression into "probably the load".

**What is not established:** *why*. A race under load is the shape the evidence fits — different
counters mean the file stopped at different points — but nothing measured says which wait or which
shared resource it is. The hypothesis is recorded as one.

## Work to do

- Find what in those assertions depends on time or on a shared resource. The two differing
  counters name the stopping points; start there.
- Make the check independent of the host's load, or — if some wait is unavoidable — make its
  failure say that it timed out rather than that the product is wrong.
- Record it in the contributing guide's section on suite isolation: a file that reads a
  machine-wide resource is already covered there, and a file that depends on the machine's *speed*
  belongs beside it.

## Out of scope

- Serialising the suite to avoid load. The runner already has a serial group for wall-clock files;
  moving a file there is a possible answer, not the subject.
- The change that was under test when this was seen — it is green on its own and on the base.

## Verification

- The file's verdict is the same under an idle machine and under a loaded one.
- A failure that is a timeout says so.
