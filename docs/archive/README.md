# Closed task archive

Every closed task is a `PB-<number>-<slug>/` directory with two files: `task.md` contains the definition (what and why, and when it appeared), and `result.md` contains the dated outcome. Completed, rejected, and merged tasks live together; `result.md` names the outcome.

Live tasks are in [backlog/](../backlog/README.md). Numbers are sequential and never reused; a missing number in the archive means that the task is still live or was never created.

A batch of minor entries is the same directory with a `minor/` subdirectory: entries closed with `npx --no-install backslop archive N.k --into M` sit there as they were, without a `result.md` of their own; the batch's `result.md` names each outcome.

Move a task with `npx --no-install backslop archive N`: it also rewrites task links throughout the repository, creates the `result.md` stub, and prints the documentation files touched by the task — the draft of the “documentation updated” line; `--range <base>..HEAD` widens the list with the commits of the range. While a `[TODO` placeholder stays in `result.md` outside code, `lint` fails; the placeholder form quoted in a code span does not count.

A closed task folds into a [LOG.md](LOG.md) journal line: `npx --no-install backslop fold N` removes the directory, appends the line, and moves incoming links onto its anchor — `LOG.md#<number in lower case>`. The definition and the result go in full into the message of the folding commit: the command prints that draft on stdout. Committing with it is mandatory when the line's commit field is `—`: the body is no longer in the tree and not yet in history. When the line names a revision, the body sits in it, and the draft is optional as long as that revision stays in history; `fold N` says on stderr which of the two cases applies. `npx --no-install backslop show N` retrieves it.

The accumulated archive folds with the same `npx --no-install backslop fold` without a number: there the body comes from history rather than from the message, and the journal line names the revision. A body missing from history is dropped with a warning unless `npx --no-install backslop fold --embed-missing` puts it into the draft, which must then be committed; its journal line carries `—` in the commit field. `--older-than <date>` folds only what was closed before that date.

Both forms are legal and live side by side for as long as you like: a directory is a task that is closed and not yet folded. Folding is not mandatory.

This file belongs to backslop: an update (`npx --no-install backslop upgrade`, the `migrate` step) rewrites it from the template of the new version, and a local edit here does not survive the next update.
