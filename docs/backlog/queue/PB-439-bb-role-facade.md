# PB-439 · Align BB role contracts, mailbox examples and approver routing

- **Order:** 650
- **Scope:** [Drivers reference](../../reference/05-drivers.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** major

## Context

The BB facade and generated role instructions disagree in four distinct ways: reporter duties exceed its registered bounded tools; teamlead instructions promise cross-task binding not supplied by the single-task facade; mailbox examples use the wrong recipient shape and a nonexistent body-by-ID operation; approver instructions promise a lateral route the facade denies. Reporter and teamlead support require explicit contract decisions before permissions change.

This batch was approved in the 2026-11-13 whole-backlog audit at source `51867619447b812a2a03fc80fa5b271490e5756c`. Its original findings remain open until execution and acceptance. Grouping is not evidence that a hypothesis is confirmed or a defect is fixed.

## Work to do

- PB-419.20: decide whether reporter support provides authorized bounded digest/status/ask-answer operations under the appropriate root-tree identity, or revises duties to an actually available route. Align generated instructions, runtime and tests with that decision.
- PB-419.21: decide between authenticated scoped root/child binding and the supported single-task teamlead contract with unavailable workflow explicitly excluded. Align renderer, protocol, runtime and tests; preserve identity and lateral-access checks.
- PB-419.22: adapt the BB renderer and regenerate affected worker/reviewer/approver skills with recipient arrays, accurate mailbox read/peek behavior and returned message bodies. Remove requirements for a nonexistent body-by-ID operation.
- PB-419.6: route BB approver messages through the orchestrator in renderer and generated instructions. Retain independent allowed-orchestrator and denied-approver-to-worker tests.
- Exercise actual registered tools and strict schemas for each affected role, including unrelated-task and unauthorized-role rejection. Preserve the separate native renderer and native communication policy.

## Acceptance criteria

- Reporter and teamlead decisions are explicit before implementation; optional Host extensions or native capabilities are not assumed to exist in the stock facade.
- Reporter tests exercise the actual tool set and supported scoped journal/status/question flow; foreign-task access, arbitrary reporter sends and writes remain denied.
- Teamlead role tests exercise supported reads and sends and reject unrelated-task and unauthorized-role access; examples match the selected binding and actual schema without unsupported cross-task promises.
- Each affected role's mailbox/send examples pass the actual BB schema, use array recipients and require no body-by-ID tool. Native renderer behavior remains correct.
- Generated approver instructions no longer promise direct worker messages; the allowed orchestrator route succeeds and the lateral route remains denied.

## Out of scope

- Silent expansion of reporter or teamlead permissions before explicit decisions.
- Arbitrary reporter sends/writes, foreign-task/role authority or an assignment overriding BB lateral restrictions.
- Changing native renderer contracts or native lateral policy.
- Assuming consumer-specific optional Host tools prove stock support; live BB integration is not certified by fixture tests.

## Verification

- After implementation, run `npm run build`, `npm --prefix integrations/bb test` and `npm test` from the repository root; notRun.
- After implementation, run `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs` from the repository root; notRun.

## Original findings and retained requirements

### PB-419.20 — Decide and align BB reporter capability contract

[Complete original finding](../deferred/PB-419.20-decide-and-align-bb-reporter-capability-contract.md).

- First decide the supported reporter contract: provide and authorize equivalent bounded digest, status and ask/answer operations with the appropriate root-tree identity, or change duties/support to an actually available route.
- Implement the chosen contract consistently in generated instructions, runtime and tests. Preserve the ban on arbitrary reporter sends and writes.
- Tests must exercise the actual reporter tool set and supported journal/status/question flow within its intended scope. Foreign-task access and arbitrary reporter sends stay denied; generated instructions match registered capabilities.
- Run `npm run build` and `npm --prefix integrations/bb test`; notRun. Live integration and external Host extensions were not tested; optional consumer tools are not universally present.

### PB-419.21 — Decide and align BB teamlead task binding contract

[Complete original finding](../deferred/PB-419.21-decide-and-align-bb-teamlead-task-binding-contract.md).

- First decide between authenticated scoped root/child binding/routing and revised supported single-task duties with unavailable workflow explicitly excluded.
- Align renderer, protocol, runtime and tests. Preserve identity checks and lateral-access restrictions.
- A role test must exercise supported reads/sends and reject unrelated-task and unauthorized-role access. Generated instructions/examples must conform to the actual schema without unsupported cross-task rights.
- Run `npm run build` and `npm --prefix integrations/bb test`; notRun. A wording change alone grants no cross-task rights; live consumer-specific routes remain untested.

### PB-419.22 — Align BB role mailbox examples with facade schema

[Complete original finding](../deferred/PB-419.22-align-bb-role-mailbox-examples-with-facade-schema.md).

- Adapt the BB renderer and regenerate affected skills with array recipients and accurate read/peek and returned-body behavior. Preserve the separate native API contract.
- Examples for each affected role must pass the actual BB schema; no instruction may require a nonexistent BB body-by-ID operation. Native renderer behavior remains correct.
- Run `npm run build`, `npm --prefix integrations/bb test` and `npm test`; notRun. This correction does not expand routing permissions.

### PB-419.6 — Route BB approver messages through orchestrator

[Complete original finding](../minor/PB-419.6-route-bb-approver-messages-through-orchestrator.md).

- Change the BB approver renderer to route through the orchestrator and regenerate the skill. Preserve native policy and the existing BB lateral-route restriction.
- Generated BB instructions must not promise the direct route the facade denies. Tests must separately retain approver-to-worker denial and exercise the allowed orchestrator route.
- Run `npm run build`, `npm --prefix integrations/bb test`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs`; notRun. No live integration session is established by this packet.

## Next step

Execute this bounded batch in queue order, preserving the separate decision or evidence prerequisites above. Native/account probes retain their own explicit boundaries; queue placement itself grants none.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.

## Ordinary member records

PB-419.20, PB-419.21, PB-419.22 remain open in deferred while this batch owns their execution. After their criteria are accepted, close each ordinary record with its own preserved task/result; `archive --into` is reserved for minor entries. Do not close any member merely because the batch was scheduled.
