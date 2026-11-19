# Promptobus Native Panel

An optional experimental BB dashboard for native Promptobus tasks. It shows a board of active runs: each run is a lane, each step of the pipeline is a column, and each piece of work is a card in the column of the step that holds it. A card opens the piece's history and, for a participant that runs in BB, its thread. Raw JSON is available under Diagnostics. The no-argument `bb promptobus-native-panel` command still returns the snapshot. Native execution, mailbox consumption, ACK, recovery, bus send, Stop and cleanup remain with Promptobus.

The plugin requires BB 0.50 from 0.50.1, Plugin SDK 0.6.157 or newer and Node 26 or newer. It is separate from the Promptobus BB adapter and does not migrate its settings or install it. Review, live installation and release acceptance are separate steps.

## Settings

Configure these fields in the plugin Settings. An incomplete selection refuses before a host call.

- **Host ID:** an enrolled BB host that can read the selected directories as its own OS user.
- **Promptobus store root:** the canonical absolute store directory containing `tasks/`, usually the task controller's `.promptobus` directory. The panel does not guess it from the current thread.
- **Native Codex state root:** the canonical absolute native registry directory containing `sessions/`, named by the controller's `PROMPTOBUS_CODEX_HOME` or Host configuration. It need not be next to the store.
- **Task ID:** optional during discovery. Choose an existing task from the page; the explicit selection is persisted in Settings and read again on each snapshot.

Discovery scans at most 4096 raw directory entries and returns at most 256 valid tasks, including newly created tasks within that scan. Invalid entries do not use the valid-task limit. Active tasks come first, then finished ones, each by update time, so finished tasks never push an active one out of the 256. If either bound leaves more entries, the page explicitly reports a truncated catalogue. A catalogue limit or failure does not block the independently read selected snapshot. Selection is shared across BB windows and survives remount and reload. Invalid legacy tasks are omitted from discovery and still fail if selected directly. Each view reads the catalogue and snapshot against one configuration revision; a concurrent Settings change invalidates the response. The page shows the host, store, native root and selected task ID, and discards late responses after disconnect or task changes.

Directories and selected records must belong to the daemon's OS user and must not cross symlinks. Configuration grants no OS permissions. A missing store/task returns `not prepared`; a missing native record remains unknown while canonical participant binding is still shown. A present malformed or mismatched launch-bound native record refuses the snapshot. Without a canonical launch binding, native detail is unavailable and the observer does not read that registry record.

The panel reads managed participants from the selected task. It reads that task journal, inbox and history directly through the owned-file boundary and validates them with the current canonical task/message schemas. It does not open an engine; an unrelated legacy journal cannot block the selected snapshot. Every canonical record that is read uses the same regular-file, ownership, symlink and size checks as native records. Canonical filesystem, parse and schema errors return fixed messages without record fragments.

Native launch detail and command receipt counts require a canonical `metadata.nativeLaunchId` that matches the selected Codex registry launch. Current worker/reviewer registration in `lib/spawn.js` and `lib/review.js` persists canonical `sessionRef`, `metadata.session` and `metadata.sessionId`, without that launch binding. The observer retains the canonical session/thread/model/effort and labels native launch/state/profile/commands unavailable for those records. It does not infer a launch from the mutable registry. Synthetic launch-bound fixtures exercise the stricter path separately; the producer test uses the actual `participantRecord` and `upsertParticipant` helpers with the worker/reviewer persist shape, without launching actors. Other harnesses retain their canonical binding and an unavailable native state. Session filenames follow the existing native registry's session-reference hash; unrelated session files are not scanned. At most 64 task participants and 32 recent canonical messages are returned. Inbox/history enumeration is limited to 64 participant directories and 4096 JSON references in the selected task; duplicate delivery references collapse to one message. The observer leaves unread inbox messages unread. Canonical/native record reads are limited to 256 KiB and receipts to 8 MiB. Canonical message previews are limited to 16000 characters with explicit truncation. Task titles, message bodies and artifact IDs are visible; native credentials, private prompts and command output are not projected.

Receipt counts describe selected `item/started`, `item/completed` and raw receipt events, not every attempted tool call. An unfinished last JSONL row is reported explicitly. Missing native records, canonical `done` and terminal close do not establish physical process drain.

Native `state` and `busy` values are stored registry values; process liveness is not checked. A retained `alive` record can remain after its processes have exited.

The page polls serially once each previous request completes. **Pause observer** pauses observation and discards late responses. **Resume observer** obtains a new sample; native actors remain owned by their controller. On an error the page labels the retained snapshot as the last successful sample.

## Board

The board discovers runs through the same owned-file boundary as the snapshot, with an 8 MiB task-record budget in addition to the discovery limits above. It samples the 16 most recently updated active runs; a further active run shows a "Not sampled" notice instead of its pieces. Finished runs are listed under **Finished runs** without pieces. One run that fails to read shows its error in its own lane and leaves the others visible.

For each sampled lane, the board scans inbox and history names, then reads at most the newest 4096 JSON references in canonical ID order across both areas. Duplicate references collapse to one message. Counting inbox names for unread totals does not read their bodies. The sample shares one 8 MiB budget across message, intent and stall records in all lanes, separate from discovery and one bounded task record per sampled lane. A lane says when older messages were omitted or the sample ran out of bytes; it still shows its pieces, but step placement and message signals may be incomplete. This caps file contents read, not directory enumeration time, and does not cache across polls. The selected snapshot and owner feed keep their existing bounds.

A piece is the slug of a step address such as `worker:parser`. A participant launched by the BB adapter records no address, so the board places it the way the adapter's own approver check does: a worker by its participant ID, an approver and its reviewer by the worker that the approver names as its predecessor. Otherwise a BB reviewer is placed by the BB worker that its review evidence names as the producer, unless an approver chose a reviewer for that worker. When several BB participants of one step would land on one worker, such as two approvers or two reviewers by evidence, none joins its card: each keeps its own piece with its thread and history, and so does a reviewer with neither link. A reviewer that approvers name for two different workers joins neither card and keeps its own, whatever order the approvers were recorded in. The card shows the model the adapter recorded for the participant's execution. Its column is the step that holds it, by the rule `promptobus digest` uses ([reference/03-cli.md#digest](../../docs/reference/03-cli.md#digest)): the first step from the piece's first participant whose participant is missing or has not reported a result since its current assignment. A piece every step has reported on is in **Done**.

For a recorded pipeline, the lane shows the order **at run start**. The observer cannot read the current host configuration. With `worker → approver` at start, a worker result puts the card in approver as a startup expectation, not evidence that approver can start. If the host adds reviewer, `digest` and step admission use the new configuration immediately. Once a reviewer joins, the board adds its column after the startup columns and includes its messages in piece history. A participant without a current result takes precedence over a predicted step. Once the lane contains a step outside the startup pipeline, it stops predicting missing participants. Cards with no observed outstanding participant or remaining startup prediction go under **Next step unconfirmed**, not Done.

Without a recorded order, the board starts with the shipped steps and appends extra steps in participant address order. The lane labels that order as inferred when it appends a step. A lane shows at most 64 pieces; a recorded pipeline and its extra observed columns together may have at most 16 steps before the lane reports an error.

An open delivery intent to or from any of a piece's participants puts **Unfinished delivery** on the card and side panel. The board checks up to 4096 entries in `intents/` (including lease names, without reading their contents). It uses the same owned-file and 256 KiB per-record checks as for history. An open intent's message does not count as a result or appear in piece history, even if some recipients already have the link. The flag disappears on a later sample once delivery closes. Observation does not recover or retry delivery. Reads are not atomic with sends or recovery; a change concurrent with a sample may show up on the next one.

A writer can expose an intent filename before its JSON is complete. If the contents cannot be parsed or the file changes during a bounded read, the board and side panel mark the sample incomplete and exclude that message ID without dropping the cards or closing the side panel. The panel cannot identify the affected participants until it can read the complete intent. Owned-file and size violations still refuse the read, including when a file grows past 256 KiB during inspection. The byte budget charges bytes actually read.

A card names the holding participant's role and model, the first line of its latest status and that status's age. Its signals are a stall the bus recorded, an open question and the number of unread inbox messages. The panel does not decide that a participant is stuck.

Clicking a card opens a side panel with the holder's identity and up to 64 messages to or from the piece's participants, filtered by kind. History uses the same newest-reference window with its own 8 MiB budget, independent of the board sample, and says when those limits omit data. **Open thread** appears for a participant whose harness is `bb`; it opens the BB thread recorded as its session reference. A native CLI participant has no BB thread, so the panel shows its session reference instead; a BB participant whose thread is not recorded yet gets no button and a note saying so. **Esc** closes the side panel and returns focus to the card. The board and each history read name the host, store and native root they came from; the panel opens only on a board from the source the piece was chosen on, a history from any other source is discarded, and the panel closes when the board changes source or no longer shows the piece, which also stops its history reads.

## Observer boundary

The background owner-notification service sends bounded message headers to an explicitly bound BB owner. It validates the canonical task owner against the latest BB native thread identity on the selected host. It does not consume mail, ACK, launch actors or control their lifecycle. The public host contract also exposes `snapshot`, `board` and `pieceHistory`.

- `tasks` returns the catalogue `{tasks, truncated, scanned}`: at most 256 valid tasks from at most 4096 scanned directory entries, with truncation explicit.
- `ownerFeed` returns `taskId`, `state`, `ownerParticipantId`, `ownerSessionRef` and up to 4096 owner message headers in `messages`: `id`, `sender`, `recipients` and `type`, without bodies. A missing task or store returns `not prepared`, an empty owner participant id, a null session reference and no messages.

Server RPC additionally exposes revision-checked `view` and `selectTask`. `selectTask` changes only the plugin's `taskId` setting after checking that the selected task exists. A view carries configuration and independent catalogue/snapshot values and errors. After remount, a broken selected snapshot still leaves the configured identity and healthy sibling choices visible. A failed catalogue still leaves a healthy selected snapshot visible.

Use **Connect owner notifications** with the actual BB owner thread. The first binding records the current message baseline. New questions, results, reviews and errors addressed to that owner can wake it while the panel is closed. Plugin-origin notices contain message IDs, not private message bodies or permission grants. Durable pending records and BB queue/history correlation prevent automatic replay after uncertain delivery or reload. An uncertain send pauses notification delivery for inspection. Switching tasks disables the previous owner binding. Building this source does not install, reload or change Settings.

The page labels polling errors, a disconnected transport and a snapshot older than ten seconds as paused or stale. A failed selected read retains the last successful sample only while host, store, native root and task all still match, with its original timestamp. A different identity never inherits that sample. A task with no messages, an empty store, a missing task and a missing native record have distinct states. On the board, a piece's question counts as open until each of its addressees answers that participant with a later message. Reviewer results retain their canonical sender role. Results, reviews and canonical task completion do not establish owner acceptance or physical process drain.

## Build and verify

Use a full checkout of the reviewed commit and run from this directory. Install the pinned root development dependencies for the producer regression test, then the plugin dependencies:

```sh
npm ci --prefix ../.. --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
bb plugin types --check .
npm run build
npm run check:clean-bundle
```

`npm test` always runs a fresh root `npm run build` through its `pretest` hook before compiling and running plugin tests. The producer regression imports the adapter in `../../lib/store.js`, which reads that generated core. It therefore requires root development dependencies even though the plugin typecheck and host bundle do not. An absent or stale root `dist/` is rebuilt from the reviewed checkout; a failed root build stops the tests. Lifecycle scripts are disabled during dependency installation so the test hook is the explicit build step.

The host statically imports canonical validators and participant helpers from `../../src/index.ts` and the record ID pattern from the canonical model. BB bundles those modules into `dist/host.js`; no root `dist/`, root dependency installation, `file:../..`, unpublished Promptobus package or author checkout is needed. These imports belong only in host code because the BB server builder refuses imports outside the plugin directory.

The build receipt in `dist/build-provenance.json` computes the actual core source tree digest, plugin input digest, Git revision when available and final host digest. It describes that build and is not a claim about an installed loader. Snapshots do not display a hardcoded core SHA. Ordinary Git installation records its exact source commit in BB's source resolution and uses BB's artifact identity metadata; it does not run this package's npm build script or produce this extra receipt.

`check:clean-bundle` creates its own temporary source copy, installs production dependencies with lifecycle scripts disabled and runs the official BB builder. It removes the copy and its dependencies before calling the resulting host artifact through the real typed host harness with a synthetic task. It verifies task/actor projection, selected receipt counts, schema rejection and unchanged fixture bytes/inbox. It starts no native actor and performs no plugin installation, model call or global temporary-directory sweep. Run `npm test` first to compile its fixture helper. An optional `--cache` argument selects an owned npm cache.

## Delivery boundary

Managed releases use the self-contained collection produced by `npm run bb:release -- --directory <new-path>`; see [BB plugin delivery](../../docs/guides/bb-plugins.md). A source checkout can install this directory with `--subdirectory integrations/bb-native-observer`. BB clones the full exact repository commit, installs only this package's production dependencies with scripts disabled and builds its declared server/app/host entries. The source import uses that same commit. A prebuilt npm release must include all declared bundles and metadata in `dist/`. Neither delivery path has been accepted merely by building a local prototype.

Installation, reload, enabling/disabling the default plugin, merging and releasing require their own acceptance step. This package performs none of them from its scripts.

## Live visual verification

Source tests and synthetic fixtures do not close visual acceptance. After source review, the controller coordinates an isolated BB installation or another approved proof route that preserves existing owner notifications. Record the exact Git commit, BB/SDK versions, built artifact identities, host ID, canonical roots and selected task ID before the demo. Use only explicitly approved real workers and reviewers.

1. Open the actual BB page during a disposable ordinary worker/reviewer run. Capture the selected task title/ID, host/store, participant roles, native thread/launch, model/profile where recorded, and timestamps. Compare those values with the canonical selected store.
2. Create another task in that store. Discover it without editing Settings, switch to it, and verify that the prior task's actors/messages never appear under its heading. Return to the original selection. Capture empty, missing-record and error states separately where available.
3. Capture a canonical question/status, worker result, reviewer outcome (including zero findings) and completed task. Compare message IDs, sender roles, bodies and artifact references with the canonical records. A review with zero findings needs no invented correction cycle.
4. During active work, disconnect/reconnect observation, remount the page, and reload only the approved isolated plugin. Verify the selected identity persists, late samples are discarded, entries catch up without duplication, and the same native launch continues. Capture connection status, the last-success timestamp and stale/error recovery.
5. Compare canonical inbox consumption, outgoing messages and actor launches before/after observation. Attribute concurrent worker changes by actor; observation must contribute no ACK/send/launch/Stop. Missing registry data and recorded idle must remain unknown process-liveness evidence.

Runtime prerequisites are Node 26 or newer, BB 0.50 from 0.50.1, SDK 0.6.157 or newer, a readable owned canonical store/native registry and an enrolled host. The managed collection includes production dependencies and app/server/host bundles; use the [delivery guide](../../docs/guides/bb-plugins.md). Building from source requires the full repository checkout because the host imports `../../src/index.ts`. Installation and settings changes require the controller's authorization.
