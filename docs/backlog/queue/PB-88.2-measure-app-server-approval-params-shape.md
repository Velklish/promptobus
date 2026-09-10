# PB-88.2 · The params shape of codex app-server approval requests is assumed from source, never measured — `item` nesting and the `permissions` field form decide whether the holder's deny rules can fire

- **Order:** 70
- **Scope:** `lib/codex-session.js` (`decideApproval`, `asksForEscalatedPermission`, `pathsOfApproval`), `test/harness-codex.mjs`, [03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-09
- **Dependencies:** PB-88

## Context

Finding of the PB-88 review (isolated reviewer, run `pb-run-0909b-t20260909-184312`). Three tasks — PB-88, PB-89 and PB-41 — reason about the params of `execCommandApproval`, `applyPatchApproval` and `item/permissions/requestApproval` from this repository's source alone: `pathsOfApproval` assumes `item/*` approvals nest under `params.item`, the holder's own reply table says `permissions` is an object (`{ permissions: {}, scope: 'session' }`), and no fixture in `test/harness-codex.mjs` ever sends a permissions request (only `execCommandApproval`). Whether the escalation deny of PB-88 can fire at all depends on that shape, and the code now stakes a security decision on the guess — it says so in a comment after PB-88's review, but the guess is still a guess. Upstream, `applyPatchApproval` is documented as able to carry a root-granting field for a patch that needs a root outside the sandbox; nothing in this repository reads it and it was not confirmed from here.

**Measured 2026-09-10**, from the schema bundle that `codex app-server generate-json-schema --out <dir>` writes on codex-cli 0.146.0 (41 files; no session started, no turn spent). The server-to-client request methods are `applyPatchApproval`, `execCommandApproval`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/call`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `account/chatgptAuthTokens/refresh` and `attestation/generate` — the last three are absent from the holder's `APPROVE` table and are answered as unknown, denied. None of the approval params nests under `item`. `item/permissions/requestApproval` carries `cwd`, `itemId`, `threadId`, `turnId`, `startedAtMs`, `reason` and `permissions: RequestPermissionProfile` — `fileSystem: { entries: [{ access: read|write|deny, path: { type: path|glob_pattern|special, … } }], read: [], write: [], globScanMaxDepth }` and `network: { enabled }`; it has no `sandbox` or `approvalPolicy` field, so the escalation vocabulary of PB-88 never matches it, and its reply's `permissions` is a `GrantedPermissionProfile` with `scope: turn | session` — the holder's current `ok` reply `{ permissions: {}, scope: 'session' }` grants nothing, and its `no` reply's `scope: 'once'` is not a value of the enum. `applyPatchApproval` carries `fileChanges` (a map keyed by path, which `pathsOfApproval` already reads) and `grantRoot: string | null`; `item/fileChange/requestApproval` carries only `itemId`, `grantRoot`, `reason` and the ids — no paths, so `pathsOfApproval` answers `[]` and the holder denies it as "action target is unreadable"; the paths live on the `fileChange` item (`changes`) that `item/started` announced. `item/commandExecution/requestApproval` carries `cwd`, `command`, `commandActions`, `networkApprovalContext`, `proposedExecpolicyAmendment` and `proposedNetworkPolicyAmendments`; its reply is `{ decision }` only, so a proposed amendment is never accepted by the holder. `execCommandApproval` carries `cwd`, `command`, `parsedCmd`, `reason`.

## Work to do

- The measurement is the protocol schema the pinned codex-cli generates about itself: `codex app-server generate-json-schema --out <dir>` on 0.146.0 (owner's decision of 2026-09-10: no live session is spent on this). Keep the approval request and response schemas — `ExecCommandApprovalParams`, `ApplyPatchApprovalParams`, `CommandExecutionRequestApprovalParams`, `FileChangeRequestApprovalParams`, `PermissionsRequestApprovalParams` and their `*Response` files — and the `ServerRequest` method list as fixtures under `test/fixtures/codex-app-server/0.146.0/`, with the command that regenerates them and the date in a README beside them.
- Make the stand in `test/harness-codex.mjs` send the measured shapes, and add a check that every approval request the stand sends and every reply the holder gives validates against the fixture schema (`ajv` is already a dev dependency).
- Align `decideApproval`, `asksForEscalatedPermission` and `pathsOfApproval` with the measured shapes — no `item` nesting, the reply `scope` enum, the `item/fileChange/requestApproval` request without paths answered with a reason that says so; replace the "assumed, unmeasured" comments with "measured on codex-cli 0.146.0 (generated schema), 2026-09-10" and cite the fixture.
- `grantRoot` on `applyPatchApproval` and `item/fileChange/requestApproval` is an escalation carried in a named field: deny it for a worker and a reviewer alike, and document it in 03-cli § The Codex holder.

## Out of scope

- Changing what is allowed or denied beyond what the measured shapes require — PB-88 and PB-88.1 own the policy.

## Verification

- The fixtures are the generated schema of codex-cli 0.146.0, named by version and date; the stand's requests and the holder's replies validate against them; the deny tests of PB-88 run against the measured shapes; `npm test` green.

## Triage — 2026-09-10

- **Track:** C — Codex session lifecycle.
- **Priority:** P1 — PB-88's deny rules stake a security decision on the shape.
- **Evidence level:** the generated schema in Context; `lib/codex-session.js:485-508` (`APPROVE`, `MUTATION_APPROVALS`), `:516-517` (the "assumed, unmeasured" comment), `:546-600` (`asksForEscalatedPermission`, `pathsOfApproval`); `test/harness-codex.mjs:578` — the stand's only approval request is `execCommandApproval`.
- **Decision (owner, 2026-09-10):** the generated schema is the measurement; no live capture.
- **Next step:** implement as the Work to do now reads, before PB-88.1; isolated review, read as a security review.
