# Closed task archive

A closed task is a line of the [LOG.md](LOG.md) journal: number with slug, closing date, outcome, the revision that holds its body, and title. Until it is folded, it is a `PB-<number>-<slug>/` directory with two files: `task.md` contains the definition (what and why, and when it appeared), and `result.md` contains the dated outcome. Completed, rejected, and merged tasks live together; the journal line, or `result.md` before the fold, names the outcome. The revision column is the commit `show N` reads the body from. For the lines of the 2026-09-23 fold, it is the last commit that touched the task's directory, not necessarily the one that closed it. A line written by `fold N` has `—` there: its body is in the message of the folding commit.

Live tasks are in [backlog/](../backlog/README.md). Numbers are sequential and never reused; a missing number in the archive means that the task is still live or was never created.

A batch of minor entries is the same directory with a `minor/` subdirectory: entries closed with `npx github:Velklish/backslop#v0.10.1 archive N.k --into M` sit there as they were, without a `result.md` of their own; the batch's `result.md` names each outcome.

Move a task with `npx github:Velklish/backslop#v0.10.1 archive N`: it also rewrites task links throughout the repository, creates the `result.md` stub, and prints the documentation files touched by the task — the draft of the “documentation updated” line.

A closed task folds into a [LOG.md](LOG.md) journal line: `npx github:Velklish/backslop#v0.10.1 fold N` removes the directory, appends the line, and moves incoming links onto its anchor — `LOG.md#<number in lower case>`. The definition and the result go in full into the message of the folding commit: the command prints that draft on stdout, and committing with it is mandatory — the body is no longer in the tree. `npx github:Velklish/backslop#v0.10.1 show N` retrieves it.

The accumulated archive folds with the same `npx github:Velklish/backslop#v0.10.1 fold` without a number: there the body comes from history rather than from the message, and the journal line names the revision. `--older-than <date>` folds only what was closed before that date.

Both forms are legal and live side by side for as long as you like: a directory is a task that is closed and not yet folded. Folding is not mandatory.
