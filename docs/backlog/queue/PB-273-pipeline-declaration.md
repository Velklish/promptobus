# PB-273 · pipeline in promptobus.json declares the owner step and the gate steps; validate refuses a second editor and a governance name

- **Order:** 100
- **Scope:** [02-host](../../reference/02-host.md), [guides/install.md](../../guides/install.md), `src/host.ts`, `src/standalone.ts`, `lib/model-routing/validate.js`, a schema `schemas/v1/pipeline.schema.json`
- **Created:** 2026-09-26
- **Dependencies:** PB-266
- **Cost:** major

## Context

The order worker, then reviewer, then approver lives only in prose: the package skill and the consumers' own texts. The owner decided on 2026-09-26 (ADR-020) that the steps after the hand-over to the worker are declared, that a person may add, remove and reorder them, and that every step is an instance of one of three kinds of right — `edits-tree`, `reads-diff`, `writes-main-tree` — from which the mechanism derives cwd, deny list and floor (PB-275). One declaration per installation; neither a repository nor a task overrides it.

## Work to do

- `promptobus.json` accepts `pipeline`: `owner` — one step of kind `edits-tree` — and `gates`, an ordered list of steps each with `name`, `kind`, optional `instructions` (a file whose text joins the lift prompt) and optional `qualityFloor`. Absent, the pipeline is `worker` / `reviewer`, `approver`, and behaviour is byte-for-byte today's.
- The schema and `models validate` refuse: a second `edits-tree` step, a duplicate name, a name outside `[a-z][a-z0-9-]{0,31}`, a name equal to a governance role (`orchestrator`, `teamlead`, `peer`, `reporter`, `user`), and `instructions` pointing at a missing file. A `--brief` at lift time is accepted only by a `writes-main-tree` step, as `review --approver` does today.
- The host exposes the declaration to every lift and to the registry (PB-266), which admits the declared names as addresses of the form `<name>:<slug>`.
- 02-host and the install guide document the key with the example of an added `reads-diff` step.

## Out of scope

- Lifting a step (PB-274) and the rights of a kind (PB-275).
- A second editing step: two writers in one worktree are refused, and the return condition is a measured need for it.
- Per-repository or per-task overrides: the owner rejected them.

## Verification

- With no `pipeline` key the existing suite passes unchanged and `status` prints the default steps.
- `models validate` names each refused case above with the offending field.
- A declaration with `security` between `reviewer` and `approver` loads, and `promptobus_task` lists the four steps in order.
