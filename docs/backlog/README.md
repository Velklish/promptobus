# Backlog

The operational tracker for promptobus: **one task is one file**, and **status is the directory** containing it. There is no task list here — `npx github:Velklish/backslop#v0.3.0 status` prints it. For overall project direction, see [ROADMAP.md](../ROADMAP.md); for closed tasks, see the [archive](../archive/README.md).

## Directories

| Directory | Contents | How it gets there |
|---|---|---|
| `triage/` | Unreviewed ideas and findings. The file is the entry | `npx github:Velklish/backslop#v0.3.0 new <slug> --title "…"`; a finding is `npx github:Velklish/backslop#v0.3.0 new <slug> --parent N` |
| `queue/` | The queue; priority is the integer “Order” field, in steps of 10; lower comes first | `npx github:Velklish/backslop#v0.3.0 new <slug> --queue [--top]`, `npx github:Velklish/backslop#v0.3.0 mv N queue [--top \| --after M]` |
| `active/` | Work in progress; “Taken” is the date it was started | `npx github:Velklish/backslop#v0.3.0 mv N active` by the person holding the queue |
| `deferred/` | Deferred work; the “Deferred” section gives the reason and return condition | `npx github:Velklish/backslop#v0.3.0 mv N deferred`, then complete the section |
| [`../archive/`](../archive/README.md) | Closed: `task.md` + `result.md` | `npx github:Velklish/backslop#v0.3.0 archive N`, then complete `result.md` |

## How to maintain it

- When an idea appears, put a one- or two-line file in `triage/`, without analysis or polish. Review is a separate pass.
- A finding from review, a worker, or a live run that this pass will not close becomes a file immediately with `--parent N`: it gets an `N.k` number and requires no coordination with neighbours. It will be lost in chat. Do not duplicate the current task.
- A verifiable claim in an entry — a number, “covered by a test”, “printed by three commands” — must include evidence: the command or file and line that produced it. If unverified, write it as a hypothesis. A definition with an incorrect fact gives the implementer wrong boundaries, and a failing test in someone else’s work is what turns it into truth.
- **Numbers are sequential** and never reused after closure; `npx github:Velklish/backslop#v0.3.0 new` assigns them across directories. Two parallel creations can take the same number; `npx github:Velklish/backslop#v0.3.0 lint` catches this at merge time, and the loser recreates the file.
- **Status = directory** is the only place status lives. A task file holds the definition, scope (a link to [reference/](../reference/README.md)), dates, and current state.
- **Priority = the “Order” field** in `queue/`. Reorder with `npx github:Velklish/backslop#v0.3.0 mv N queue --top`, `--after M`, or by editing the number manually.
- **Closure** — completed, rejected, or merged — uses `npx github:Velklish/backslop#v0.3.0 archive N`: the file moves to the archive as `task.md`, alongside a dated `result.md`. The approver completes the outcome and result; while `result.md` contains `[TODO]`, `lint` fails.
- A deferred task gets a “Deferred” section with its reason and return condition; without them, `lint` fails.
- A task that becomes an architectural decision moves to an [ADR](../README.md); the task file keeps a link.
- Project gates are the `gates` field in `backslop.json`; `npx github:Velklish/backslop#v0.3.0 lint` is among them.

## Triage cadence

There are two review points, and neither replaces the other:

- **before a worker run, in full**, before splitting the queue into tracks: entries from earlier runs belong exactly to the subsystems being split now and join this run’s tracks at no extra cost;
- **after every closed task**, for entries accumulated during that task, not whenever enough have accumulated.

An entry that sits through several runs loses context: its author was a session that no longer exists.

The agent decides without asking:

- merge a duplicate into an existing task or clarify its wording;
- put an entry in the queue and choose its place;
- defer it with a return condition.

Review verifies a factual claim with evidence before queuing it; unverified text is rewritten as a hypothesis. The agent asks the owner **only before rejecting** an entry: a finding discarded without asking will not be rediscovered. Ordering is agent work; the owner sets goals and reverses priority when needed.

Review is complete when every `triage/` entry has a next step: it was merged, moved to another directory, or closed by the owner’s decision.
