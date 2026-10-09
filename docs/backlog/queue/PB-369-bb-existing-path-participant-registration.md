# PB-369 · The BB participant CLI cannot register an existing worktree path directly

- **Order:** 67
- **Scope:** [Host integration](../../reference/02-host.md)
- **Created:** 2026-10-09
- **Dependencies:** none
- **Cost:** major

## Context

The BB adapter accepts an existing environment id or creates a managed worktree from the project checkout. A project can coordinate independent repositories whose worktrees are not part of that checkout. Registering one of those existing paths currently requires a separate BB thread before `participant add` can use its environment id.

Evidence: source `bb-plugin-promptobus/runtime.ts:232-257` accepts an environment id and calls `recordBbWorkspace`; `bb-plugin-promptobus/lifecycle.ts:71-81` resolves that id through the SDK. On the accepted adapter source `5f1f08044c8f5f26afd6b65e2e7de272cce0ab3d`, `bb promptobus participant add --help` returned exit 0 with no existing-path option.

The operator tried a separate `bb thread spawn --environment <existing-worktree-path> --send-at 7d --json`. Spawn returned exit 0 with `environmentId=null`, `status=pending`. The deferred message was deleted with exit 0; passing the null id to the participant command was then refused by the calling Python process before that command ran. Deferring spawn also defers provisioning; that expected BB behavior is not a product defect.

A supported workaround was measured: send a preparation-only turn requesting `READY`, wait for idle, and obtain the environment through `bb thread show`. These commands returned exit 0; the environment was ready, its path matched the isolated Git worktree, and the helper produced `READY` with zero command executions. Adding the actual participant with the returned environment id and then archiving the empty helper both returned exit 0. The gap is the adapter's direct path-registration flow and the unnecessary extra thread, not a demonstrated failure of BB environment creation.

Runtime identifiers and personal filesystem paths are omitted from this public record. The operator retains the exact command receipts and helper event log for review.

## Work to do

- Provide an explicit supported route for a participant's existing local worktree path in the coordinator's BB project. Prefer reusing the adapter's bounded provisioning/bootstrap mechanism; inspect the public SDK before selecting the API.
- Resolve the real environment id and verify project, host, path, Git HEAD and lifecycle before canonical binding and assignment delivery.
- Document provisioning timing and prevent an unknown or null environment id from being treated as a successful worker launch.
- Preserve the current environment-id and managed-worktree modes.

## Out of scope

- Changes to other harnesses, shared workspace defaults, global concurrency settings or BB core.
- Rebinding an arbitrary existing thread as an orchestrator.
- Broad repository discovery or changing the standalone Host contract beyond this participant setup path.

## Verification

- A local existing-path participant is bound to the intended project, host and isolated worktree without an unbound helper thread performing a model turn.
- Missing paths, invalid Git workspaces, mismatched environments and ambiguous provisioning replies refuse assignment delivery and preserve recoverable launch evidence.
- Existing environment-id and new managed-worktree flows retain their documented behavior.
- A focused fixture fails on the old behavior and passes with the implementation. Any live test uses disposable threads and repositories, preserves evidence and affects no unrelated workspace user.

## Triage

2026-10-09: queue immediately after the test-group task. Current source `ea81f0d8643d923aecf140b813ae9ae521270d23`, `bb-plugin-promptobus/runtime.ts:237-267`, exposes environment-id reuse and managed-worktree creation but no direct existing-path input. `bb-plugin-promptobus/lifecycle.ts:71-81` validates an already resolved environment. The recorded READY-helper workaround establishes the operational cost; no new helper/model turn was launched during triage. Inspect the public SDK provisioning route before choosing the narrow participant option, then add refusal and identity-preservation fixtures. PB-286.2 concerns native repository-path resolution and does not replace this BB setup task.
