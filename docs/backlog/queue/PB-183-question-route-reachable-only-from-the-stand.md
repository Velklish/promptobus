# PB-183 · The human-facing route for a held Cursor dialog is reachable only from the stand, so nothing tests it against production

- **Order:** 175
- **Scope:** `lib/driver-cursor.js` (`inspect`, `stallRoute` for `kind === 'question'`),
  `test/harness-cursor.mjs`
- **Created:** 2026-09-12
- **Dependencies:** `PB-181` — the route's text is fixed there, on the branch that closed it; in
  `main` it still reads the way this card quotes

## Context

Found 2026-09-12 while fixing `PB-181`. The route a person is shown when a Cursor session is held
at a dialog lives under `kind === 'question'` in `stallRoute`. **Nothing in production ever
produces that kind.** `inspect` in the same file returns `gone | stale | watchdog | failed |
unknown`; the only source of `'question'` is the stand — `test/harness-cursor.mjs`, a branch that
returns it when the fixture says the session asked one.

So the check on that branch is green independently of the product: the branch is exercised, the
code path a person meets is not. This is the fourth of the four measured shapes of a green check
aimed elsewhere — a control reachable only from the thing that controls it.

**Removing the branch is the wrong fix**, and that is why this is a card rather than a deletion:
it is the only place where a person is told what to do about a held dialog, and a held dialog is
real — measured at `278.497 s`, ended by a keypress, in `PB-181`.

**The verdict is distinguishable, which is what makes the fix possible.** At the moment of the
hold the transcript stops growing, no tool process hangs off the pane, nothing is written in the
worktree — all three liveness signals silent, which is exactly what the watchdog already reports
with a number each. What it does not do is look at the panel, where the dialog's own text is
rendered.

**And one stale line beside it.** `test/harness-cursor.mjs` carries a comment saying "a question
gets a skip", which `PB-181` measured to be false.

## Decision, taken 2026-09-12

**Retire the kind and fold its guidance into the verdict that does fire.** At the moment of the
hold all three liveness signals are silent, and that is exactly what the watchdog verdict already
reports with a number each; what it lacks is not detection but the sentence telling a person what
to do. Moving that sentence there closes the gap with what already fires.

**Rejected: teaching `inspect` to return `question`.** It is feasible — the dialog's text is
rendered in the panel and can be read with `capture-pane`, measured on a live session — but it puts
a panel read into every liveness check, for a state the existing verdict already establishes. A
second detector for an already-detected state is cost without an answer.

## Work to do

- Retire `kind === 'question'` and carry its guidance into the watchdog verdict.
- Whatever is chosen, the check must exercise the production path, not the fixture's shortcut.
- Correct the stale comment in the stand.

## Out of scope

- The route's wording — `PB-181` fixed it.
- The watchdog's three signals, which work and report numbers.

## Verification

- A held dialog produces the human-facing route from production code, shown by a run rather than
  by a fixture flag.
- No branch of `stallRoute` is reachable only from the stand.
