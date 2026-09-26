# PB-276 · Model routing answers for a step name: floor from the declaration or from the kind

- **Order:** 130
- **Scope:** [03-cli § Model routing](../../reference/03-cli.md#model-routing), `lib/models.js`, `lib/model-routing/resolver.js`, `lib/model-routing/telemetry.js`, `schemas/model-routing/`
- **Created:** 2026-09-26
- **Dependencies:** PB-273, PB-266
- **Cost:** major

## Context

`ROUTED_ROLES` is `worker`, `reviewer`, `approver`, with floors 5, 9 and 7, and the catalog rates tuples per role. A declared step (PB-273) has a name of its own and a kind; without routing by step, `step security` has no way to pick a model.

## Work to do

- `models --role <step name>` and every routed lift resolve a step to its catalog role through the kind — `edits-tree` → worker, `reads-diff` → reviewer, `writes-main-tree` → approver — and apply the step's `qualityFloor` when declared, the kind's floor otherwise.
- The routing decision and the telemetry record carry the step name beside the catalog role, so `calibrate` and `status` report per step.
- Overlay `byRole` selectors accept a step name; validation reports an unknown name against the declaration.

## Out of scope

- New catalog rows or ratings: the catalog stays rated per kind.

## Verification

- `models --role security` on a declaration with `security` of kind `reads-diff` prints candidates at floor 9; with `qualityFloor: 7` declared, at 7.
- A routed `step security` writes `metadata.routing` with the step name and the catalog role; `done` writes a telemetry record carrying both.
- `models validate` names an overlay `byRole` key that matches no declared step and no role.
