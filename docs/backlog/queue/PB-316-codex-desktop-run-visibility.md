# PB-316 · Show Promptobus run activity in the Codex Desktop chat and measure idle-chat wake support

- **Order:** 200
- **Scope:** [Codex driver](../../reference/05-drivers.md#codex--codex-harness-driver--the-third-production-bus-driver), [the Codex holder](../../reference/03-cli.md#the-codex-holder), [Digest](../../reference/03-cli.md#digest), [Report](../../reference/03-cli.md#report)
- **Created:** 2026-10-01
- **Dependencies:** none
- **Cost:** major

## Context

On 2026-10-01 the owner compared the same orchestration workflow in Claude Code and Codex Desktop. The supplied Claude Code screenshot shows incoming "Message from another session" notifications and the orchestrator's replies in the human's conversation. The owner reports that the Codex Desktop conversation shows neither the incoming notifications nor the ongoing work of the managed orchestrator.

Promptobus can deliver mail to a managed Codex participant, but that participant's thread is distinct from the human's Desktop conversation. A person needs to see worker progress, questions requiring a decision, results and failures without repeatedly asking whether anything is happening.

This task covers visibility in the Desktop conversation. Waking an idle conversation after its answer has ended is a separate capability to measure, not an established property of Codex and not a promise to reproduce Claude Code's notification card exactly.

## Evidence

- Source inspected at `bbbd2cc234acbd75aeded35c18103a6b2903425d`, package version `0.21.0`: `lib/driver-codex.js:1209` declares `attach: false`; `activate` at `:760-805` sends `turn/start` to the thread held by Promptobus. `lib/driver-claude.js:437-448` sends the inter-session message to a live Claude Code messaging socket instead.
- `lib/codex-session.js:991-1014` handles app-server notifications. For ordinary events it logs the method name; this handler supplies no human-facing forwarding of the participant's agent messages to the Desktop conversation.
- The consumer's installed package was `0.22.0`, newer than the inspected main checkout. Its `lib/driver-codex.js:858-862` still sends wakes to the managed thread and `:1327` still declares `attach: false`. Its `lib/report-channel.js:35-47` starts a question turn, reads that turn with `thread/read`, and prints its completed agent messages. That is an on-demand answer channel, not evidence of automatic delivery into the human's Desktop conversation. Recheck these locations against the implementation base before coding.
- A consumer-host invocation of `digest --task <selected-root> --json` on 2026-10-01 exited 0 and returned both workers' latest status lines for the run shown in the screenshot. Bus data was available during this investigation; the owner's Codex UI symptom has not yet been reproduced in a controlled live stand.
- [OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server), read on 2026-10-01, describes `thread/read`, `turn/start`, `item/agentMessage/delta` and completed items. It establishes event and history access for an app-server client, not a supported way for our holder to inject a notification into an existing Codex Desktop conversation.

## Work to do

- Reproduce the owner-reported visibility gap on a disposable run. Record the Desktop and CLI versions, package revision, managed thread identity, human conversation identity, bus message ids and what the person can actually see.
- Provide an observation path that a Codex Desktop agent can use while its turn is active. Prefer reading the canonical journal with a cursor and bounded waiting; choose the exact CLI/MCP surface during implementation rather than treating a proposed tool name as a decided contract.
- Surface new participant status, questions requiring human input, results, failures and meaningful session-state changes in the human's conversation. Include the source address, task, time and message id when available; distinguish a reported result from accepted work.
- Observation must not claim the orchestrator address, consume its mailbox or start another orchestrator. Keep delivery and answer handling with the existing owner.
- Preserve event order and prevent duplicates when observation resumes. Show an observation failure or stale state explicitly instead of silently ending the feed. Avoid repeated model turns just to discover that nothing changed.
- Measure whether a supported mechanism can wake the existing local Desktop conversation after its answer ends. If none is available, document that boundary and the supported active-turn observation workflow; do not describe idle-chat wake as implemented. Treat an unsupported route as a recorded limitation, not a reason to leave active-turn visibility unfinished.
- Update the Codex driver/holder reference and orchestration guidance with the supported workflow and its measured limits. Reconcile the newer reporter behavior before publishing guidance.

## Out of scope

- Replacing the managed-owner lifecycle or changing bus message routing and permissions.
- A general-purpose dashboard, a new reporting model solely to relay existing status text, or changes to Claude Code's notification presentation.
- Editing Codex's private history storage or treating service notifications as human instructions or permission grants.
- Promising a native "Message from another session" card without a measured supported Desktop integration.

## Verification

- A live Codex Desktop run visibly shows two workers' status messages, a question requiring a human decision, a result and a failure/state change during the active observing turn. Evidence names source message ids and separates worker report, review and acceptance.
- Before/after mailbox evidence proves observation neither changes the orchestrator's unread messages nor replaces its owner. An unrelated active root produces no events in the selected run's feed.
- Focused checks cover cursor continuation, ordering, duplicate prevention and a failed observation. Empty waits do not create extra model turns solely for polling.
- The idle-conversation measurement records its version, command or action, outcome and limitations. The documentation makes active-turn visibility and idle-chat wake support distinct.
- Every performed check records its exact command, exit code and implementation revision. Live evidence is required for UI delivery; a CLI digest or stub test alone does not establish that the Desktop person saw an event.
