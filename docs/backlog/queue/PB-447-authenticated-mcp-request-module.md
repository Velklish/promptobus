# PB-447 · Encapsulate authenticated MCP request admission for both endpoints

- **Order:** 720
- **Scope:** [Shared HTTP service](../../reference/03-cli.md), [Host](../../reference/02-host.md), [Protocol](../../reference/04-protocol.md)
- **Created:** 2026-11-16
- **Dependencies:** none
- **Kind:** behavior-preserving architectural refactor
- **Design:** confirmed by the owner on 2026-11-16; implementation not started or authorized by registration

## Context

The HTTP handler in `lib/service.ts` assembles the admission protocol itself. It authenticates, receives a fence, reads the body, refreshes proof, prepares a client Host, refreshes proof again, then enters synchronous authority and the task lock before dispatch. A caller must know where every wait can invalidate the grant or native observation. Importing a check while leaving these checkpoints in the handler would preserve that temporal interface.

The confirmed design puts the whole authenticated MCP request flow behind one internal module for both `bus` and `reviewer_files`. The HTTP adapter supplies transport data and a lazy body reader, invokes the module and sends its response. The caller does not receive or schedule a fence. Existing native proof, locking and receipts/replay mechanisms retain their contracts.

Origin: architecture review of Promptobus 0.33.0, 2026-11-16, candidate 01 and its owner-confirmed design. Source at review and registration: `9dfdbddd66840bc5c0596cc6753fc44323a86b72`. The review used static source/test inspection, not executed build, tests, mutation probes or live qualification. This is a structural improvement, not evidence of a runtime admission defect or measured performance gain. This task retains the design and checks without depending on the temporary HTML report.

### Evidence and reading map

Line ranges below belong to the source commit above. Re-resolve by the named functions if implementation starts on a later tree.

| Source | What to inspect |
|---|---|
| `lib/service.ts:496–509`, `contextFor` | Client Host preparation and revalidation after its asynchronous creation. |
| `lib/service.ts:511–606`, `currentGrant`, `authorizeCurrent`, `authorizeGrant`, `authorizeAttempt`, `authenticateClient` | Grant identity, bounded revision-drift retry, fresh native observation and the returned synchronous fence. |
| `lib/service.ts:948–1047`, HTTP request handler | Authentication/body/factory/dispatch checkpoints, MCP session branches, root mutation bookkeeping and synchronous managed journal entry. |
| `lib/service.ts:306–327, 438–452`, session cleanup and `dispatch` | Ordinary session receipts versus nonce-keyed ROOT/BB receipts, replay and outcome storage. |
| `lib/native-admission.ts`, `src/fs/lock.ts` | Existing native publication proof and synchronous authority/task-lock mechanisms. |
| `test/service-operation-authority.test.mjs:7–10, 59` | Admission tests read generated source, slice function text and execute it with `new Function`. |
| `test/service-operation-authority.test.mjs:90–101` | Separate extraction for cached lifetime observations, outside this task. |
| `test/shared-service-operation-authority.test.mjs:197–224, 243–280` | Existing HTTP witnesses for drift, contention, retained partial outcomes, telemetry and identity replacement. Inspected, not run for the review. |

### Confirmed responsibility boundary

- The module owns admission before body reading, refresh after waits, MCP session flow, client Host preparation, final fence and managed journal entry. It calls existing dispatch at the appropriate point.
- The interface covers the entire authenticated request, not only `tools/call`: initialize, notifications, discovery, ping, session deletion and method-specific refusal branches are included.
- POST follows its existing read-body/revalidate branches. GET and DELETE keep their own branches. Do not flatten all methods into one linear proof sequence.
- Construct the module per shared-service owner. Host, env, cwd, grants and sessions do not become process-global state. Request data cannot substitute for owner-issued authority.
- The result supplies response status, headers and body. TypeScript type names, file name and constructor shape remain implementation choices, not new public API.

### Receipts remain a separate responsibility

- Ordinary process/managed calls store receipts under the MCP session. ROOT/BB calls use a separate nonce-keyed namespace that survives session deletion.
- A `completed` outcome can contain an error after a partial effect. It does not mean an atomic success. A retry must not execute that effect again.
- An unresolved `started` outcome does not permit automatic repetition. A different request with the same id retains the existing refusal.
- Bus replay returns the stored response. An allowed repeated reviewer file read reads the file again rather than returning stale file contents.
- Do not promise rollback or absence of all pre-dispatch effects. Host preparation, session metadata, counters and caches can change earlier.
- Keep receipt keys, storage, cleanup, lifetime and replay rules intact. ROOT/BB are not converted to managed lifetime.

## Work to do

1. Record the current HTTP response/session matrix for both endpoints and locate existing witnesses. Preserve status, headers, body and refusal precedence as compatibility constraints.
2. Introduce the per-owner internal request module. Reuse current native-proof adapters, synchronous authority, task lock and dispatch rather than adding an authorization framework.
3. Move authenticated request orchestration behind that interface. Leave transport handling in the HTTP adapter, without manual proof/fence/entry composition or managed-journal failure classification there.
4. Keep admission before lazy body reading and revalidation after waits, including Host preparation and native observation.
5. Preserve the synchronous final fence → task lock → dispatch section. Do not insert an `await`. Retain the distinction between refusal before journal entry and failure after possible effects.
6. Migrate admission checks from source extraction to the request interface production uses. Control body-reader, Host-preparation and native-observation waits through bounded fixtures or existing adapters, not a public bag of private dependencies.
7. Add endpoint/session-flow and replay witnesses below. Keep existing HTTP tests; helper checks cannot replace them.
8. Document the internal responsibility and unchanged behavior in the relevant reference/subsystem documentation and CHANGELOG. Preserve [ADR-040](../../adr/adr-040-shared-workspace-service.md) and [ADR-039](../../adr/adr-039-terminal-send-barrier.md). Register an ADR only if implementation introduces a decision beyond those contracts.

## Acceptance criteria

- The HTTP adapter no longer constructs the admission sequence, receives/calls a returned fence, repeats proof checkpoints or chooses the managed-journal entry branch.
- One internal interface serves production and admission tests. Admission checks no longer extract implementation with `indexOf`/`slice`/`new Function`.
- Invalid or revoked authority refuses before body reading. A controlled lazy reader proves it was not called, and the test compares the prior response.
- Revocation, generation replacement and drift during body reading, Host preparation or native observation cannot reach unauthorized dispatch. Tests control ordering rather than relying on a sleep.
- Fresh proof, synchronous authority and task-lock contention retain prior outcomes. Refusal before journal entry invokes no tool and creates no `started` receipt.
- The three allowed proof attempts apply only to eligible revision drift, never to repeating a tool. Identity drift, revoked grant, dead and unknown stay distinct. The actual Codex telemetry-only publication exception is not broadened.
- Both endpoints retain initialize, initialized notification, discovery, ping and DELETE behavior, session identity, protocol validation, statuses, headers and error precedence. Reviewer read ceilings and native-call checks remain enforced.
- Bus replay, repeated permitted file reading, same-id/different-request refusal, retained partial completed outcome and unresolved started outcome each have a witness. No automatic operation repeat is introduced.
- Ordinary session cleanup and ROOT/BB receipt retention have separate tests. Shared request handling does not unify their lifetimes.
- Existing HTTP witnesses for dead/unknown, revocation, generation replacement, revision/telemetry drift, contention and partial-outcome replay remain meaningful. No public exports or rights are added.
- The result names the remaining cached-observation source extraction. Removing admission extraction is not reported as removing all extraction from `service-operation-authority.test.mjs`.

## Out of scope

- Reorganizing receipts, replay, root/BB recovery or introducing a transaction/rollback across the request.
- Redesigning native proof, owner-control IPC, warden, cached status observations or task-lock rules.
- Removing the cached-observation extraction at `test/service-operation-authority.test.mjs:90–101`.
- Changing HTTP behavior, tools, grants, public exports, supported harnesses or owner scope.
- Participant launch consolidation or BB Stop/resume refactoring. They are not prerequisites for this module.
- Treating this task as completion of PB-416.5 — Verify shared-service workflows recovery and process footprint. Its qualification remains independently open.

## Verification

- Future implementation checks, all notRun at registration: `npm run build`; `node test/service-operation-authority.test.mjs`; `node test/service-operation-locks.test.mjs`; `node test/shared-service-operation-authority.test.mjs`; `node test/shared-service.test.mjs`; `node test/shared-service-managed-launch.test.mjs`; `node test/shared-service-standalone-root.test.mjs`.
- Add a scenario-to-assertion table naming endpoint, held boundary, changed authority, response and dispatch/receipt evidence. Include the whole session flow, not only bus tool calls.
- After committed test changes, use `npm run probe` with targeted mutations for pre-body admission, post-wait revalidation and the final authority/lock boundary. Record which assertions fail and what the probes do not establish.
- Run configured `npx --no-install backslop gates --require-clean --base <implementation-base>` and retain exact commands, exit codes and gate counts. These future checks are not results of architecture review or card registration.
- Account-backed, live or stress qualification requires separate scope and authorization. Static inspection and deterministic fixtures do not establish it.

## Risks and next step

The main risk is admitting once at request start and dispatching after authority changes during a wait. Controlled-wait tests and the final synchronous section must detect that regression. Another risk is repeating an operation after a partial effect while simplifying errors; retain receipt-specific witnesses rather than adding general retry.

Next step: execute in queue order after the owner authorizes implementation and its execution/review method. The owner confirmed the design, not an implementation run. Do not reopen the settled endpoint, whole-request or receipt boundaries merely to choose file/type names.
