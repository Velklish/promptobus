# PB-397 · Show native Promptobus work in a visual BB dashboard

- **Scope:** [Host and BB integration](../../reference/02-host.md), native observer UI and read-only task projection
- **Created:** 2026-10-26
- **Dependencies:** none
- **Cost:** —
- **Previous order:** 40
- **Taken:** 2026-10-26

## Context

On 2026-10-26 the owner requested a usable visual BB dashboard as the first delivery in the next backlog run. The installed native panel currently renders a diagnostic JSON snapshot. The person cannot readily see which task is selected, what participants are doing, what needs attention, or whether displayed data is current.

Evidence: local installed candidate `a19212d734b85219cd2d0242147ff17c9af76037`, `integrations/bb-native-observer/app.tsx:21-25`, registers a navigation panel and renders `JSON.stringify(snapshot)`. Its `server.ts:7-14` selects one task through Settings; `poll.ts` polls sequentially with a one-second delay. The source belongs to the unmerged native candidate, so reconcile it with the implementation branch before editing; do not assume that this main checkout already contains it.

Native Codex sessions remain owned by Promptobus. They do not become BB threads, and the observer does not mirror their chats into the BB sidebar. This task makes their work understandable inside a dedicated BB page; it does not change their execution owner.

## Work to do

- Replace the default JSON view with a readable dashboard: selected task, task state, participants and roles, recorded activity, current questions, latest status, results, review outcome and errors. Keep raw JSON in an optional diagnostics section.
- Let the person discover and select tasks in the configured store without manually copying a new task ID into Settings. Persist the explicit selection and always display its store/task identity; never silently mix runs.
- Provide participant details with native launch/thread identity, model and permission profile where available, timestamps and readable canonical messages/artifact references. Clearly distinguish a reported result, a review and accepted work. Do not present unavailable command output or a complete native transcript as captured data.
- Show connection state, last successful update and stale/error/empty states. Reconnect, page remount and plugin reload must recover the selected view without restarting work or duplicating participants/messages.
- Explain in the UI that native participants are Promptobus sessions rather than BB threads. Separate recorded activity from process-liveness evidence and label unavailable evidence honestly; do not invent a completion percentage from command counters.
- Preserve observer-only behavior: use supported read-only projections, do not consume/ACK mail, claim an orchestrator seat, launch actors or perform Stop/recovery. Document the supported visibility and refresh behavior in the integration README and Host reference.

## Out of scope

- Creating surrogate BB threads, bidirectional chat mirroring, or moving native lifecycle ownership to BB.
- New execution/approval/recovery controls, a replacement orchestration framework, model-routing changes or permission widening.
- Closing historical live-readiness criteria merely because their state is visible in the dashboard.

## Verification

- Run focused UI/projection checks for multiple tasks, selection persistence, participants with different roles, questions/results/errors, empty data, stale snapshots and recovery after polling failure. A new task is selectable without editing Settings manually.
- First demonstrate a disposable ordinary worker/reviewer run through the actual BB page. Capture active work, a canonical result, review outcome and completed task; compare the displayed identities and messages with the selected canonical store. A reported zero-findings review needs no invented finding/fix cycle.
- During active work, disconnect/reconnect the observer, remount the page and reload only the plugin. Verify the same native launch continues and the view catches up without duplicate entries. Observation must not alter mailbox consumption or send/launch/Stop anything.
- Verify that an unrelated task cannot appear under the selected task's heading, and that missing registry data or recorded idle is not presented as proven process death.
- After the functional demo, obtain independent review of the implementation and fix actual findings. Record exact commands, exit codes, source revision and live UI evidence; static tests or a JSON CLI snapshot alone do not satisfy visual acceptance.
