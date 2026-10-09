# PB-370 · BB participant threads and environments need clear default display names

- **Scope:** [Host integration](../../reference/02-host.md)
- **Created:** 2026-10-09
- **Dependencies:** none
- **Cost:** minor

## Evidence

The user asked to make the clearer naming used in the current BB run the default in the Promptobus integration. A sidebar screenshot made an unrelated worker look as though it belonged to the preceding worktree group. The actual environment bindings were correct; this is a display clarity problem, not a demonstrated workspace isolation failure.

Evidence: accepted adapter source `5f1f08044c8f5f26afd6b65e2e7de272cce0ab3d`, `bb-plugin-promptobus/runtime.ts:147`, constructs `Promptobus ${b.role}: ${b.participant}` and provides no card/subject display label. `bb thread show` returned exit 0 and confirmed the TASK-12 worker's own worktree, branch and environment even though its sidebar position appeared adjacent to the TASK-18 group. `bb thread-list prefs list --json` returned exit 0 with `organizationMode=project`, `environmentGrouping=auto`. The installed Thread list source groups sibling worktree threads only when at least two share the environment; a lone worker has no folder heading, so its own title must be understandable.

The supported local workaround uses `bb thread update <thread-id> --title <display-title> --json` and `bb environment update <environment-id> --name <display-name> --json`. Seventeen commands returned exit 0, naming 10 task-owned threads and 7 environments. Neutral examples: `TASK-12 · Worker · Markdown anchors`, `TASK-7 · Review · staging mv`, `TASK-12 · Backslop`; the related pair is explicitly `TASK-18 + TASK-18.1 · sample-repo`. Exact argv, exits and responses are preserved in the private run's `naming-receipts.json`; private runtime ids and host paths are omitted here. The workaround also runs after later worker/reviewer launches in this run, but it is not an installed integration default.

Expected: a participant thread identifies its card or task, role and short subject even without an environment heading; a task-owned environment identifies the card or related pair and repository. Actual: the integration emits a technical participant-based thread title and leaves this display naming to the orchestrator. Impact: the operator can misread task/worktree ownership while coordinating parallel participants.

Acceptance placement is part of the same requirement. With `environmentGrouping=auto`, the installed BB Thread list groups sibling threads only when their environment is a worktree and at least two siblings share that actual environment id. An acceptance participant normally has its own isolated worktree and is the only thread in that environment, so a clear environment name alone leaves it outside the worker/reviewer folder. Giving separate environments identical names does not combine them.

The raw BB metadata operation is `bb thread update <acceptance-thread-id> --parent-thread <matching-worker-thread-id> --json`. In the current run, eight such updates returned exit 0 and preserved environment id, path and `lifecycleOwnerThreadId`; receipts are in the private run's `acceptance-sidebar-parent-update.json`. Those state checks did not establish that the Promptobus binding remained usable.

The subsequent acceptance launch demonstrated the missing check: changing only the BB parent made `bb promptobus participant get --task <task-id> --participant <participant-id>` report `status="BB binding mismatch"`; the participant reported `BB thread binding mismatch` for its task and host-context tools. Its recorded parent remained the orchestrator while the actual BB parent was the worker. `bb-plugin-promptobus/runtime.ts:32-37` requires the actual `parentThreadId` and `lifecycleOwnerThreadId` to match the registered binding; `lifecycle.ts:18-19` checks them too. Restore the registered parent to recover the current run, retaining the original update receipts and the correction in `acceptance-parent-binding-restoration.json`. A raw BB parent update is therefore not a supported workaround for a bound participant. The requested default needs binding-aware integration support; expected sidebar grouping alone is not a BB core defect.

Evidence: Current source ea81f0d8643d923aecf140b813ae9ae521270d23, bb-plugin-promptobus/runtime.ts:32-37, authenticates parent and lifecycle-owner binding. The evidence above preserves the actual reparent binding mismatch and restoration receipts from the 2026-10-09 run; no live metadata changes were repeated during triage.

## Work to do

- Add clear default display naming to the BB participant launch path, using existing public SDK metadata operations. Carry a narrow explicit display label/subject from the caller when needed; use a deterministic task/participant fallback when it is absent, rather than parsing arbitrary assignment Markdown.
- Keep the card/task label and role near the beginning of the thread title so they remain visible when the sidebar truncates it. Apply the same convention to workers, reviewers and approvers.
- Name environments created and owned by the task with the card or explicit related pair and repository. A worker and its reviewer sharing one environment keep one coherent environment name.
- Place a newly created acceptance/approver thread under the matching task's worker by default, including an explicitly related pair. Resolve that worker from authenticated participant bindings; keep the acceptance title readable as card/task, `Acceptance`, and short subject. Set the BB parent and the integration's registered parent consistently through a supported launch or metadata operation; do not patch private binding storage or weaken identity checks.
- Keep display ancestry separate from execution and lifecycle ownership: the acceptance participant retains its dedicated worktree, environment binding and orchestrator lifecycle owner. Preserve worker/reviewer predecessor bindings and canonical participant identity; changing the UI parent must not transfer stop/resume ownership to the worker.
- Preserve existing user-supplied environment names and unrelated/shared project environments. Display names must not change canonical participant ids, task ids, environment bindings, paths, branches or lifecycle ownership.
- Document the default and supported caller override in the BB integration reference. Keep naming metadata failures visible without claiming launch or naming success that was not confirmed.

## Out of scope

- BB core/sidebar rendering changes, global Thread list preferences or regrouping unrelated threads. Task-owned acceptance placement through supported metadata operations is in scope.
- Renaming unrelated threads, moving worktrees or rebinding participants.
- Other harnesses, release/install changes, workspace pins, implementation of the current run's unrelated backlog or a general title-generation subsystem.

## Verification

- A focused launch fixture fails with the old participant-only title and passes with the new default; cover worker, reviewer and approver.
- The title remains meaningful for a lone worker; worker/reviewer sharing an environment receive consistent labels. An explicitly related pair is named as a pair.
- With the normal worker/reviewer environment group and a separate acceptance environment, the acceptance thread appears below the matching worker inside that task's group. Cover a single task and an explicitly related pair; identical environment display names must not be treated as shared environment identity.
- Before/after state proves that acceptance environment id, worktree path, branch, lifecycle owner and predecessor bindings are unchanged. Orchestrator stop/resume still reaches the acceptance participant; unrelated threads and Thread list preferences remain untouched.
- A regression reproduces the old failure when only BB `parentThreadId` changes. With the new supported placement, participant inspection has no binding mismatch, authenticated `promptobus_task` and `promptobus_mailbox` work, predecessor checks remain enforced, and orchestrator stop/resume reaches the same participant. Validate these operations, not only the sidebar and a successful metadata command.
- Caller override and deterministic fallback work without changing canonical identity or the bound Git worktree. Existing custom/shared environment names are preserved.
- A metadata operation failure is reported with its actual outcome; no unrelated environment or thread is renamed.
- Run the mandatory repository gates on the accepted SHA and record exact commands, exits and counts. Any live BB check uses disposable task-owned threads/environments and preserves other workspace users' settings.

## Triage

2026-10-09: move to the owning minor backlog for a later batch, preserving the user's nonblocking minor policy. Current source `ea81f0d8643d923aecf140b813ae9ae521270d23`, `bb-plugin-promptobus/runtime.ts:32-37`, still authenticates the actual parent and lifecycle owner against the registered binding. The recorded reparent failure and restoration above remain the evidence; triage did not repeat live metadata changes. Naming/placement must use a supported binding-aware path, and a batch must retain the authenticated-tool and stop/resume regression requirements. PB-350.4 addresses command-grant coordination, a different acceptance-delay cause; do not merge the two findings or weaken identity checks.
