# Backlog

The operational tracker for promptobus: **one task is one file**, and **status is the directory** containing it. There is no task list here — `npx github:Velklish/backslop#v0.9.0 status` prints it. For overall project direction, see [ROADMAP.md](../ROADMAP.md); for closed tasks, see the [archive](../archive/README.md).

## Directories

| Directory | Contents | How it gets there |
|---|---|---|
| `triage/` | Unreviewed ideas and findings. The file is the entry | `npx github:Velklish/backslop#v0.9.0 new <slug> --title "…"`; a `major` finding outside the current task's scope is `npx github:Velklish/backslop#v0.9.0 new <slug> --parent N[.M]` |
| `queue/` | The queue; priority is the integer “Order” field, in steps of 10; lower comes first | `npx github:Velklish/backslop#v0.9.0 new <slug> --queue [--top]`, `npx github:Velklish/backslop#v0.9.0 mv N queue [--top \| --after M]` |
| `active/` | Work in progress; “Taken” is the date it was started | `npx github:Velklish/backslop#v0.9.0 mv N… active` by the person holding the queue |
| `deferred/` | Deferred work; the “Deferred” section gives the reason and return condition | `npx github:Velklish/backslop#v0.9.0 mv N deferred`; if the section is already present, the command does not append it and prints “section exists; check the reason and return condition” |
| `minor/` | Minor findings and hypotheses: they wait for a batch, not for review; the “Cost” field is required, “Scope” is filled in when batches are cut | `npx github:Velklish/backslop#v0.9.0 new <slug> --parent N[.M] --minor [--cost <level>] [--hypothesis]`; `npx github:Velklish/backslop#v0.9.0 mv N minor` |
| [`../archive/`](../archive/README.md) | Closed: `task.md` + `result.md`; minor entries in the batch's `minor/` | `npx github:Velklish/backslop#v0.9.0 archive N`, then complete `result.md`; a minor entry — `npx github:Velklish/backslop#v0.9.0 archive N.k --into M` once batch M is closed |

## How to maintain it

- When an idea appears, put a one- or two-line file in `triage/`, without analysis or polish. Review is a separate pass.
- **A finding carries a cost label, and the label decides its route.** The scale is the reviewer's: `critical` — it breaks in use, loses data, or grants a right nobody granted; `major` — a stated contract or rule is broken, or a case the change claims to cover stays unchecked; `minor` — the cost is local and nothing else depends on it. In doubt, raise the label: an understated one hides an expensive finding among cheap ones. The approver does not accept a finding without a label.
- `critical` is fixed now: within the finder's boundaries by the finder; in another track's files by a message to the orchestrator in the same turn, without waiting for the result. `major` in the same “Scope” as the current task is fixed now on its branch and named in the result. `major` in another scope becomes a card in `triage/`: `--parent N` gets an `N.k` number, `--parent N.M` gets the next free `N.k` and stores the exact finding in the `Parent` field. It will be lost in chat; do not duplicate the current task.
- `minor` and any finding without evidence — `--parent N[.M] --minor`: an `N.k` file in `minor/` with the `Parent` and `Cost` fields and an `Evidence` section. A hypothesis carries the assumed label with a mark: `--cost major --hypothesis` writes `major (hypothesis)`; `major` and `critical` without the mark in `minor/` are a `lint` error: with evidence they are fixed, not queued for a batch.
- A verifiable claim in an entry — a number, “covered by a test”, “printed by three commands” — must include evidence: the command or file and line that produced it. If unverified, write it as a hypothesis. A definition with an incorrect fact gives the implementer wrong boundaries, and a failing test in someone else’s work is what turns it into truth.
- A finding under a closed parent may remain in `triage/`: `lint` warns the approver but does not fail the gate.
- **Numbers are sequential** and never reused after closure; `npx github:Velklish/backslop#v0.9.0 new` assigns them across the directories of the current tree, the repository’s other worktrees, and all local branches — a worker in a worktree and the orchestrator in the main tree get different numbers, and the command names the foreign number it skipped. A collision remains possible with a clone or an unfetched remote branch; `npx github:Velklish/backslop#v0.9.0 lint` catches it at merge time, and the loser recreates the file.
- **Status = directory** is the only place status lives. A task file holds the definition, scope (a link to [reference/](../reference/README.md)), dates, and current state.
- **“Scope”** links to a [reference/](../reference/README.md) section: in `queue/`, `active/`, and `deferred/` an empty field or a field whose entire value is a `[TODO…]` placeholder left by `npx github:Velklish/backslop#v0.9.0 new` is a `lint` error; in `triage/` the field is not checked — it is filled in during review; in `minor/` an empty field is a warning, and the approver fills it in when cutting batches. A standalone `[TODO…]` placeholder line in any markdown file under `docs/backlog/**` also fails `lint`; `[TODO]` inside explanatory text, as part of a larger value, is not a placeholder.
- **Priority = the “Order” field** in `queue/`. Reorder with `npx github:Velklish/backslop#v0.9.0 mv N queue --top` or `--after M`, including a task already in the queue: the file stays, only the number changes. Two files with one “Order” is a `lint` error.
- **Closure** — completed, rejected, or merged — uses `npx github:Velklish/backslop#v0.9.0 archive N`: the file moves to the archive as `task.md`, alongside a dated `result.md`, and the output names the documentation files touched by the task (`--range <base>..HEAD` widens the selection with the range's commits). The approver completes the outcome and result; while `result.md` contains `[TODO]`, `lint` fails. A `minor/` entry is closed by a batch: `npx github:Velklish/backslop#v0.9.0 archive N.k --into M` moves its file into `archive/<M>-<slug>/minor/` without a `result.md` of its own, and its outcome is one line in the batch's `result.md`; the batch is closed first.
- **Quote** — a regular `quote:<path>` block guards a file invariant. A `quote:before:<path>` block stores a pre-change snapshot: content drift does not fail `lint`, but the target and closing marker remain required.
- A deferred task gets a “Deferred” section with its reason and return condition; if the section is already present, `npx github:Velklish/backslop#v0.9.0 mv N deferred` does not append it and prints “section exists; check the reason and return condition”; without completed fields, `lint` fails.
- A task that becomes an architectural decision moves to an [ADR](../README.md); the task file keeps a link.
- Project gates are the `gates` field in `backslop.json`; `npx github:Velklish/backslop#v0.9.0 lint` is among them.

## Triage cadence

There are two review points, and neither replaces the other:

- **before a worker run, in full**, before splitting the queue into tracks: entries from earlier runs belong exactly to the subsystems being split now and join this run’s tracks at no extra cost;
- **after every closed task**, for entries accumulated during that task, not whenever enough have accumulated.

An entry that sits through several runs loses context: its author was a session that no longer exists.

**Minor batches are cut at the same point, before the run.** The approver walks `minor/` — `npx github:Velklish/backslop#v0.9.0 status` prints it by scope — fills in empty “Scope” fields and assembles one batch card per scope: the scope the run touches anyway, or one with ten or more entries. A batch is an ordinary card, `npx github:Velklish/backslop#v0.9.0 new <slug> --queue --title "…"`, listing the numbers under “Work to do”. The owner may order a batch at any time. Closing batch M: first `npx github:Velklish/backslop#v0.9.0 archive M`, then `npx github:Velklish/backslop#v0.9.0 archive N.k --into M` for each entry, and their outcomes as lines in the batch's `result.md`.

The agent decides without asking:

- merge a duplicate into an existing task or clarify its wording;
- put an entry in the queue and choose its place;
- defer it with a return condition.

Review verifies a factual claim with evidence before queuing it; unverified text is rewritten as a hypothesis. The agent asks the owner **only before rejecting** an entry: a finding discarded without asking will not be rediscovered. Ordering is agent work; the owner sets goals and reverses priority when needed.

Review is complete when every `triage/` entry has a next step: it was merged, moved to another directory, or closed by the owner’s decision.
