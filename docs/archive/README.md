# Closed task archive

Every closed task is a `PB-<number>-<slug>/` directory with two files: `task.md` contains the definition (what and why, and when it appeared), and `result.md` contains the dated outcome. Completed, rejected, and merged tasks live together; `result.md` names the outcome.

Live tasks are in [backlog/](../backlog/README.md). Numbers are sequential and never reused; a missing number in the archive means that the task is still live or was never created.

Move a task with `npx github:Velklish/backslop#v0.3.0 archive N`: it also rewrites task links throughout the repository and creates the `result.md` stub.
