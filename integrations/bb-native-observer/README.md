# Promptobus Native Panel

An optional experimental BB dashboard for native Promptobus tasks. It shows task selection, managed participants, questions, status and results; raw JSON is available under Diagnostics. The no-argument `bb promptobus-native-panel` command still returns the snapshot. Native execution, mailbox consumption, ACK, recovery, bus send, Stop and cleanup remain with Promptobus.

The plugin requires BB 0.47.1 or newer, without an upper BB version limit, and uses Plugin SDK 0.6.79. It is separate from the older Promptobus BB adapter and does not migrate its settings or install it. Review, live installation and release acceptance are separate steps.

## Settings

Configure these fields in the plugin Settings. An incomplete selection refuses before a host call.

- **Host ID:** an enrolled BB host that can read the selected directories as its own OS user.
- **Promptobus store root:** the canonical absolute store directory containing `tasks/`, usually the task controller's `.promptobus` directory. The panel does not guess it from the current thread.
- **Native Codex state root:** the canonical absolute native registry directory containing `sessions/`, named by the controller's `PROMPTOBUS_CODEX_HOME` or Host configuration. It need not be next to the store.
- **Task ID:** optional during discovery. Choose an existing task from the page; the explicit selection is persisted in Settings and read again on each snapshot.

Discovery scans at most 4096 raw directory entries and returns at most 256 valid tasks, including newly created tasks within that scan. Invalid entries do not use the valid-task limit. If either bound leaves more entries, the page explicitly reports a truncated catalogue; the returned subset is sorted by update time. A catalogue limit or failure does not block the independently read selected snapshot. Selection is shared across BB windows and survives remount and reload. Invalid legacy tasks are omitted from discovery and still fail if selected directly. Each view reads the catalogue and snapshot against one configuration revision; a concurrent Settings change invalidates the response. The page shows the host, store, native root and selected task ID, and discards late responses after disconnect or task changes.

Directories and selected records must belong to the daemon's OS user and must not cross symlinks. Configuration grants no OS permissions. A missing store/task returns `not prepared`; a missing native record remains unknown while canonical participant binding is still shown. A present malformed or mismatched launch-bound native record refuses the snapshot. Without a canonical launch binding, native detail is unavailable and the observer does not read that registry record.

The panel reads managed participants from the selected task. It reads that task journal, inbox and history directly through the owned-file boundary and validates them with the current canonical task/message schemas. It does not open an engine; an unrelated legacy journal cannot block the selected snapshot. Every canonical record that is read uses the same regular-file, ownership, symlink and size checks as native records. Canonical filesystem, parse and schema errors return fixed messages without record fragments.

Native launch detail and command receipt counts require a canonical `metadata.nativeLaunchId` that matches the selected Codex registry launch. Current worker/reviewer registration in `lib/spawn.js` and `lib/review.js` persists canonical `sessionRef`, `metadata.session` and `metadata.sessionId`, without that launch binding. The observer retains the canonical session/thread/model/effort and labels native launch/state/profile/commands unavailable for those records. It does not infer a launch from the mutable registry. Synthetic launch-bound fixtures exercise the stricter path separately; the producer test uses the actual `participantRecord` and `upsertParticipant` helpers with the worker/reviewer persist shape, without launching actors. Other harnesses retain their canonical binding and an unavailable native state. Session filenames follow the existing native registry's session-reference hash; unrelated session files are not scanned. At most 64 task participants and 32 recent canonical messages are returned. Inbox/history enumeration is limited to 64 participant directories and 4096 JSON references in the selected task; duplicate delivery references collapse to one message. The observer leaves unread inbox messages unread. Canonical/native record reads are limited to 256 KiB and receipts to 8 MiB. Canonical message previews are limited to 16000 characters with explicit truncation. Task titles, message bodies and artifact IDs are visible; native credentials, private prompts and command output are not projected.

Receipt counts describe selected `item/started`, `item/completed` and raw receipt events, not every attempted tool call. An unfinished last JSONL row is reported explicitly. Missing native records, canonical `done` and terminal close do not establish physical process drain.

Native `state` and `busy` values are stored registry values; process liveness is not checked. A retained `alive` record can remain after its processes have exited.

The page polls serially once each previous request completes. **Disconnect observer** pauses observation and discards late responses. **Reconnect observer** obtains a new snapshot; native actors remain owned by their controller. On an error the page labels the retained snapshot as the last successful sample.

## Observer boundary

This source contains no notification sender, owner-thread binding, background service, bus send, mailbox ACK, actor launch or lifecycle control. `selectTask` changes only the plugin's `taskId` setting after checking that the selected task exists. The public host contract exposes only `snapshot` and `tasks`; the latter returns `{tasks, truncated, scanned}`. Server RPC additionally exposes revision-checked `view` and `selectTask`. A view carries configuration and independent catalogue/snapshot values and errors. After remount, a broken selected snapshot still leaves the configured identity and healthy sibling choices visible. A failed catalogue still leaves a healthy selected snapshot visible.

An installed bundle may also contain an owner-notification extension. This observer source is not a claim about that bundle and must not replace it without a separate installation decision that preserves the installed service. Building this source does not install, reload or change Settings.

The page labels polling errors, a disconnected transport and a snapshot older than ten seconds as paused or stale. A failed selected read retains the last successful sample only while host, store, native root and task all still match, with its original timestamp. A different identity never inherits that sample. A task with no messages, an empty store, a missing task and a missing native record have distinct states. Questions are recent recorded messages; the panel does not infer whether they remain unanswered. Reviewer results retain their canonical sender role. Results, reviews and canonical task completion do not establish owner acceptance or physical process drain.

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

The host statically imports canonical validators and participant helpers from the package's public source entry at `../../src/index.ts`. BB bundles those modules into `dist/host.js`; no root `dist/`, root dependency installation, `file:../..`, unpublished Promptobus package or author checkout is needed. The import belongs only in host code because the BB server builder refuses imports outside the plugin directory.

The build receipt in `dist/build-provenance.json` computes the actual core source tree digest, plugin input digest, Git revision when available and final host digest. It describes that build and is not a claim about an installed loader. Snapshots do not display a hardcoded core SHA. Ordinary Git installation records its exact source commit in BB's source resolution and uses BB's artifact identity metadata; it does not run this package's npm build script or produce this extra receipt.

`check:clean-bundle` creates its own temporary source copy, installs production dependencies with lifecycle scripts disabled and runs the official BB builder. It removes the copy and its dependencies before calling the resulting host artifact through the real typed host harness with a synthetic task. It verifies task/actor projection, selected receipt counts, schema rejection and unchanged fixture bytes/inbox. It starts no native actor and performs no plugin installation, model call or global temporary-directory sweep. Run `npm test` first to compile its fixture helper. An optional `--cache` argument selects an owned npm cache.

## Delivery boundary

A future accepted Git release can install this directory with `--subdirectory integrations/bb-native-observer`. BB clones the full exact repository commit, installs only this package's production dependencies with scripts disabled and builds its declared server/app/host entries. The source import uses that same commit. A prebuilt npm release must include all declared bundles and metadata in `dist/`. Neither delivery path has been accepted merely by building a local prototype.

Installation, reload, enabling/disabling the default plugin, merging and releasing require their own acceptance step. This package performs none of them from its scripts.

## Live visual verification

Source tests and synthetic fixtures do not close visual acceptance. After source review, the controller coordinates an isolated BB installation or another approved proof route that preserves existing owner notifications. Record the exact Git commit, BB/SDK versions, built artifact identities, host ID, canonical roots and selected task ID before the demo. Use only explicitly approved real workers and reviewers.

1. Open the actual BB page during a disposable ordinary worker/reviewer run. Capture the selected task title/ID, host/store, participant roles, native thread/launch, model/profile where recorded, and timestamps. Compare those values with the canonical selected store.
2. Create another task in that store. Discover it without editing Settings, switch to it, and verify that the prior task's actors/messages never appear under its heading. Return to the original selection. Capture empty, missing-record and error states separately where available.
3. Capture a canonical question/status, worker result, reviewer outcome (including zero findings) and completed task. Compare message IDs, sender roles, bodies and artifact references with the canonical records. A review with zero findings needs no invented correction cycle.
4. During active work, disconnect/reconnect observation, remount the page, and reload only the approved isolated plugin. Verify the selected identity persists, late samples are discarded, entries catch up without duplication, and the same native launch continues. Capture connection status, the last-success timestamp and stale/error recovery.
5. Compare canonical inbox consumption, outgoing messages and actor launches before/after observation. Attribute concurrent worker changes by actor; observation must contribute no ACK/send/launch/Stop. Missing registry data and recorded idle must remain unknown process-liveness evidence.

Install prerequisites: an exact full repository checkout (the host imports `../../src/index.ts`), Node 22 or newer, BB 0.47.1 or newer, SDK 0.6.79, production `zod`, a readable owned canonical store/native registry and an enrolled host. A Git delivery uses `--subdirectory integrations/bb-native-observer`; a prebuilt delivery needs the declared app/server/host bundles and metadata. Installation and settings changes require the controller's separate decision.
