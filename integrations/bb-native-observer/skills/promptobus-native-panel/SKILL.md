---
name: promptobus-native-panel
description: Observe selected native Promptobus tasks and canonical messages in a BB dashboard.
---

# Promptobus Native Panel

Use `bb promptobus-native-panel` without arguments to read the configured snapshot. Configure `hostId`, `storeRoot` and `nativeRoot` in plugin Settings, then choose a task on the page. No task or path is inferred from the calling thread. The selected task is shared by windows and persists in plugin Settings.

The page displays the selected host, store and task identity, managed participants, canonical owner, and recent inbox/history messages. Observation leaves unread mail unread. Native detail comes from matching Codex registry and receipt records; other harnesses retain canonical bindings with unavailable native detail.

Disconnect pauses the page and discards late reads. Reconnect and remount read the persisted selection. Errors label retained samples as stale. Registry activity is recorded evidence, including when a record says `alive`; it is not a process-liveness check. Results and reviews do not establish owner acceptance, and command counts do not measure overall progress. Full native transcripts and command output are unavailable.

The observer provides no notification sender, execution, approval, recovery or Stop controls. Use the controller's separately authorized lifecycle route for actor operations. This source must not silently replace an installed owner-notification extension.
