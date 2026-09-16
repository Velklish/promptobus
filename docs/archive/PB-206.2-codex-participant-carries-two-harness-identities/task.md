# PB-206.2 · Identity-swap checks cannot isolate inside a Codex participant sandbox, and the mechanism is not yet established

- **Order:** 60
- **Scope:** `lib/driver-codex.js` (the participant environment), `test/promptobus-dismiss.test.mjs`, `test/promptobus-mcp.test.mjs`, `test/promptobus-review.test.mjs`, `test/promptobus-spawn.test.mjs`; adjacent — a card of the consumer's own backlog records the same family from the other side, closed there by masking four environment variables
- **Created:** 2026-09-12, from a Codex worker's baseline in run opt0912
- **Dependencies:** none

## Context

A Codex participant lifted by `spawn` ran the project suite in its own worktree before making any edit. 7 of 64 files went red. Twenty-five of the failures are one mechanism, and it is not a clock.

The suite's own output says two harnesses name themselves at once and that an ancestor's identity leaked — but **where the second one comes from is not established**, see the correction below. The tests that exercise foreign-session behaviour replace or delete only the identity of the harness they are testing, so the second identity survives the swap and the "foreign" session resolves as the owner. The suite says so itself in its own output: `2 harnesses name themselves at once … an ancestor's identity leaked`.

Failing families, each measured twice back to back with the exit code of the `node --test` command itself, load average beside every run:

| file | verdicts | runs |
|---|---|---|
| `promptobus-dismiss.test.mjs` | 23/26, 3 red | rc 1 twice, load 8.67 |
| `promptobus-mcp.test.mjs` | 90/106, 16 red | rc 1 twice, load 7.87 |
| `promptobus-review.test.mjs` | 174/176, 2 red then abort | rc 1 twice, load 8.12 / 7.36 |
| `promptobus-spawn.test.mjs` | 121/125, 4 red | rc 1 twice, load 23.33 / 21.83 |

The representative expectation, from `promptobus-dismiss.test.mjs`:

```
foreign.failed && /mailbox owner/.test(foreign.out) && foreign.out.includes(OWNER)
  && foreign.out.includes('sess-gost') && /mailbox \{claim: true\}/.test(foreign.out)
```

Actual: the command **succeeds** — `✔ worker:api dismissed from watch …` — and the next assertion prints the participant carrying a fresh `metadata.dismissed`. A refusal that should have named a foreign session instead went through as the owner's own.

> Source: 2026-09-12, run opt0912, worker `pb-role` in a Codex sandbox; fourteen runs, seven files twice each, `node --test test/<file> > log; echo $?`. Full logs in the task artifacts of that run.

**This is not the load class.** [PB-159.1](../../backlog/active/PB-159.1-pooled-load-reds-beyond-preflight.md) recorded its wall-clock reds at load averages 115…198; here the load stayed between 7 and 23, and the same reds repeat at the low end. The orchestrator measured the same suite green outside a participant sandbox on the same machine and the same tree content the same hour: `gates` exit 0, `gates 4, green 4`, `npm test` exit 0, 165 115 ms.

**Control 2026-09-12, a participant sandbox of another harness.** A Claude participant lifted by `spawn` into a worktree of this same repository, within the same hour and on the same machine, ran the full suite: `npm test` exit 0, **64 of 64 files**, and the four files of this card among them. So the contamination is a property of the **Codex** participant environment, not of participant sandboxes in general, and not of the machine. That narrows the fix to the Codex driver rather than to the tests.

**Correction 2026-09-12, and it disproves this card's stated mechanism.** The title and the paragraph above first said the participant's environment exports both identity variables. It does not. Measured inside a live Codex participant of run `opt0912`, by `hasOwnProperty` plus `trim` on `process.env`, values not printed:

| variable | state |
|---|---|
| `CODEX_THREAD_ID` | present, non-empty |
| `CLAUDE_CODE_SESSION_ID` | **absent** |
| `CURSOR_CONVERSATION_ID` | absent |

Every other name of `PARENT_SESSION_ENV` is absent as well, except `CODEX_HOME`; none of the listed variables is present-but-empty. So `identityCandidates` sees exactly one candidate in the participant's shell, and the tests are children of that shell.

**The hypothesis was then proved, in both directions, and it is the reverse of the original claim.** `test/promptobus-dismiss.test.mjs:35–46`, helper `withSession`, sets `process.env.CLAUDE_CODE_SESSION_ID` itself and saves and restores only that variable; it never clears the ambient `CODEX_THREAD_ID`. Inside a Codex participant the ambient identity is exactly that variable, so the fixture's own subject and the real sandbox's identity stand side by side and the code sees two harnesses naming themselves at once.

| run | result |
|---|---|
| `node test/promptobus-dismiss.test.mjs` as the participant has it | 23/26, stable over two baseline runs |
| `env -u CODEX_THREAD_ID node test/promptobus-dismiss.test.mjs` | **exit 0, 26/26**, no identity warning |

Removing the ambient variable is the whole difference. The driver hands a participant one identity and does so correctly; **the subject is identity isolation in the test fixtures, not the participant environment.**

**And the suite is green on a Claude participant by coincidence, not by isolation.** There the ambient identity is the very variable the fixture overwrites and restores, so only one ever exists. Any participant whose harness differs from the fixture's subject meets the same collision — a Cursor participant is predicted to fail the same way, and that prediction is unmeasured.

The measurement that disproved the original paragraph was taken by the worker that was about to make the driver fix, on its own session, before touching anything — and such a session cannot be raised again once the driver changes.

## Work to do

- Make the fixtures neutralise **every** known harness identity for the duration of a check, not only the one they install. The mechanism is established; what is left is where the neutralising lives — in each fixture, in a shared helper, or in the runner that starts the file.
- Whichever is chosen, name the full set of identity variables in one place — the neighbouring repository already masked four of them for its own class-A and that list is a second copy waiting to drift.
- State the consequence for a run: while this stands, a Codex participant cannot produce a green gate summary for this package, so its definition of done cannot require one.

## Out of scope

- The socket refusal that aborts guard, e2e and mixed — PB-206.3; different mechanism, same baseline.
- Any change to what `spawn` exports for a Claude participant: nothing here says the Claude side is wrong.

## Checks

- A Codex participant's environment carries exactly one harness identity — checked by printing the environment inside a lifted participant, not by reading the driver.
- The four files above go green inside a participant sandbox, twice each, with the exit code of each run.
- The reds do not reappear at a load average comparable to this measurement; if they do, the residue is a separate class and gets its own record.
