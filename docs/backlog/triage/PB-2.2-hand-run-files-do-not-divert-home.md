# PB-2.2 · A suite file run by hand writes under the real home unless it imports the shared verdict helper

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none

## Context

Finding discovered while working on PB-2; the evidence is the `strategy` track's, reported over the bus on 2026-09-05.

Home is diverted in two places, and neither covers a `node --test` file run by hand. [test/run.mjs](../../../test/run.mjs) builds a per-file home for every child of a run, and [test/check.mjs](../../../test/check.mjs) diverts `process.env` home at module load when the environment still holds the real one — but only for files that IMPORT it. A file written against `node:test` imports the verdict helper not at all, so run alone it sees `os.homedir()` and writes there.

Live evidence from the `strategy` track: running one of the two routing test files by hand wrote a model-availability cache under the operator's real home. The route is the same class as PB-2's other two — `HOME` and `TMPDIR` sandboxed, and something escaping past them — but the escape here is the absence of an apply, not a `PATH` and not an unset variable.

Which files are exposed is a directory question, and the count belongs in the entry once measured: every `test/*.test.mjs` that does not import `./check.mjs`. Today that is the `node:test` family — the model-routing files, `host.test.mjs`, `boundary.test.mjs` and their neighbours.

Why it was not fixed with the sealed PATH: the fix has to reach each of those files (an import, or a shared preamble module they all load), and they belong to other tracks of the routing run. Editing a dozen files across three tracks for a hazard nobody was hitting in a runner-driven run is a change to make deliberately, in one pass, not as a side effect of sealing `PATH`.

What is verified: that `check.mjs` is the only apply point for a hand run, that it reaches only its importers, and the strategy track's measurement of a cache written under the real home. What is NOT verified: how many files are exposed and what each of them writes.

## Work to do

- Count the exposed files: every `test/*.test.mjs` with no `./check.mjs` import. Say the number and name what each writes under home, so the fix is judged against damage rather than against a category.
- Then divert home for a hand run in ONE place they all reach. The candidates are a preamble module imported like `check.mjs` is, and `node --test`'s own setup hook — the second needs no edit in any file but only fires under `node --test`, and some of these files are run as plain `node <file>`.
- A gate afterwards, in the shape the suite already uses for `SERIAL` membership and the sweep prefix list: a check that walks the directory and refuses a suite file that applies neither.

## Out of scope

- The runner path. It diverts home per file and is not in question.
- `~/.cursor` and the other harness-owned homes: those are the harness's, and the suite moves them with their own variables.

## Verification

- A file from the exposed list, run by hand with the real home in the environment, writes nothing outside its sandbox — measured by watching the home directory across the run, not by reading the code.
- Mutation probe on the gate: remove the apply from one file, the gate names that file.
