# PB-88.1 · A worker's `item/permissions/requestApproval` gets no cwd/addDirs containment check, so widening the writable roots under `workspace-write` is auto-approved

- **Order:** 80
- **Scope:** `lib/codex-session.js` (`decideApproval`, `MUTATION_APPROVALS`, `pathsOfApproval`), `test/promptobus-driver-codex.test.mjs`, [03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-09
- **Dependencies:** PB-88

## Context

Finding of the PB-88 review (isolated reviewer, run `pb-run-0909b-t20260909-184312`), from the source; PB-88's own Out of scope leaves containment untouched. `MUTATION_APPROVALS` lists the methods whose paths are checked against `cwd` and `addDirs` (`pathsOfApproval` reads `params.item.changes|fileChanges|path|file`); `item/permissions/requestApproval` is not among them, so for a worker the only thing between that request and `allow: true` is the escalation-value check of PB-88. A request that keeps `sandbox: 'workspace-write'` but names additional writable roots outside `cwd`/`addDirs` carries no dangerous value and no path the containment reads — it is auto-approved on the roots dimension. Before PB-88 the blob regex `workspace-write.*outside` closed this by wording accident only; after PB-88 it is deterministically open.

## Work to do

- Deny every `item/permissions/requestApproval` from a worker, as the holder already does for a reviewer (owner-side decision of 2026-09-10: nothing widens — the mechanism launched the worker with `cwd` and `addDirs` as its writable roots, and a request for more roots or for network is the escalation the holder exists to refuse). The refusal names the requested file-system entries and the network flag in PB-88.2's measured shape.
- Fix the `no` reply: on codex-cli 0.146.0 `scope` is `turn | session`, and the current `once` is not a value the schema accepts.
- Regression: a request naming a root outside `cwd`/`addDirs`, one naming a root inside, and one asking for network are each denied, and the reply validates against the PB-88.2 response fixture.
- Say in 03-cli § The Codex holder which requests the containment covers and that permission requests are refused for both roles.

## Out of scope

- The escalation-value check itself — PB-88.
- The wire shape — PB-88.2, which lands first; read the roots from its fixture.

## Verification

- The regression is red before the repair and green after; the Codex driver suite and `npm test` stay green.

## Triage — 2026-09-10

- **Track:** C — Codex session lifecycle, after PB-88.2.
- **Priority:** P1.
- **Evidence level:** source review at `3ccdf27`: `lib/codex-session.js:503-508` (`MUTATION_APPROVALS` without the permissions method), `:709-711` (the reviewer-only denial), `:718-745` (containment for the mutation methods only). PB-88.2's measured shape: the widened roots travel in `permissions.fileSystem.entries[].path`, `.write[]` and `.read[]`, network in `permissions.network.enabled`; the current "approve" reply grants an empty `GrantedPermissionProfile`, so nothing was widened in effect — the answer was wrong in form and scope, not in outcome.
- **Decision:** nothing widens; no root-walk is implemented, because no request is approved; the reply is the `no` row with a lawful scope.
- **Next step:** implement with the regression as written; isolated review.
