# ADR-001: Tasks and decisions are managed with backslop

**Status:** Accepted
**Date:** 2026-09-04
**Deciders:** [TODO: project owner]

## Context

The project needs a task tracker and decision log that live alongside code, can be read by an agent without external services, and do not conflict when branches are worked on in parallel. A task list in one file conflicts on every closure; decisions scattered across chats cannot be found when needed.

## Decision

Tasks and decisions are managed with backslop:

- a task is a `PB-<number>-<slug>.md` file; its status is the `docs/backlog/{triage,queue,active,deferred}/` directory; closed tasks live in `docs/archive/<id>-<slug>/` with `task.md` and `result.md`;
- queue priority is the “Order” field in the file; `npx github:Velklish/backslop#v0.3.0 new` assigns numbers across directories, while findings get `N.k` without coordination;
- decisions are ADRs in `docs/adr/` with a row in `docs/README.md`; an accepted decision is replaced by a new one, not edited;
- the change procedure and worker/approver roles are in the backslop section of `AGENTS.md`; details are in `backslop-task` and `backslop-batch`, and documentation population is in `backslop-seed`;
- gates are `npx github:Velklish/backslop#v0.3.0 lint` plus `gates` from `backslop.json`;
- the tool version is pinned in `backslop.json` (`cli` with a tag and the `version` stamp); update with `npx github:Velklish/backslop#v0.3.0 upgrade`, while `migrate` changes file formats between versions.

## Consequences

- Changing status is a `git mv` of one file: two branches conflict only on the same task.
- There is no task list in git — `npx github:Velklish/backslop#v0.3.0 status` provides the summary; opening the backlog README to see the queue is pointless.
- The cost is discipline: `lint` maintains links, numbers, and fields, but authors maintain the substance of task definitions and results.
