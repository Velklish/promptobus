# Fixture `legacy-v061` — anonymized legacy store snapshot

This frozen `v0.61.0` snapshot is the input to both the
[legacy reader test](../../promptobus-legacy-fixture.test.mjs) and the
[migration test](../../promptobus-migration.test.mjs). The tests read a copy
of the snapshot; they do not regenerate it.

## Provenance

| Item | Recorded origin |
|---|---|
| Store format | `v0.61.0`, recorded at capture time as commit `8ca22be` |
| Store records | The former `scripts/make-promptobus-fixture.mjs` called `createTask`, `upsertParticipant`, `bindSession`, `sendMessage`, `readInbox`, `closeTask`, `writeWake`, `claimWarden` and `logWarden` in the legacy store |
| Health and warden log | The former generator drove `wardenRound` from [warden.js](../../../lib/warden.js) with fixed time and socket outcomes |
| Current state | Frozen compatibility input; no recapture is performed |

The original generator and the recorded baseline revision are not preserved
in this complete public repository. There is no working Git recovery command
for either one here. The snapshot itself and its current consumers are the
reproducible sources: run the linked tests to check how the legacy reader and
migration handle these bytes. Changes to today's reader or migration should
update their tests while leaving this snapshot intact. A new snapshot would
need its own generator and provenance; it would not replace this one.

The historical capture notes say that the generator wrote the store layout
through the legacy API and produced health and log entries through a real
`wardenRound`, using the `knock` seam only to fix time and socket outcomes.
That matters because `channel`, `wake` and `knockError` came from the
knock branch, while the log format came from the warden. Reconstructing these
records by hand through `writeHealth` would create different evidence.

Two entries were intentionally outside the normal API: a truncated message
(described below), and the first log line, written from the `promptobus
warden` command's startup format rather than by a warden round.

## Why the snapshot is frozen

When the generator was available, a second capture produced the same 17 file
hashes. It fixed the clock because the store stamped `created`, `ts`,
`beat` and message filenames with real time. Warden pid `424242` is a
deliberately dead stand-in. These are historical capture notes, not a claim
that the missing generator can be run from this checkout.

After the protocol v1 cutover, the legacy store remains for reading and
migration. The current warden writes to the new store, so recapturing the old
health and log records with current code would not reproduce the original
input. The 17 tracked fixture files therefore remain byte-for-byte frozen.

## Contents

| Item | Path or property |
|---|---|
| Active task | `tasks/t20260831-090000/task.json` |
| Closed task | `tasks/t20260830-140000/task.json`, with `status: done` and `closed` |
| Participants | Both tasks contain an orchestrator with an owner, workers and `reviewer:demo` |
| Session binding | `sessions/00000000-0000-4000-8000-000000000001.json` belongs only to the active task |
| Inbox | One message for the orchestrator; three for `worker:demo`, including one truncated file |
| Read mail | Three messages for the active orchestrator, one for `reviewer:demo`, and the closed task's read mail |
| Artifact | `tasks/t20260831-090000/artifacts/demo-diff.patch`, named by message `20260831T094000000-0005-worker-demo.json` |
| Health | `tasks/t20260831-090000/health.json` covers socket delivery, self-wake fallback and a collected mailbox |
| Warden state | `tasks/t20260831-090000/supervisor.json` and an eleven-line `supervisor.log` |
| Damaged message | `tasks/t20260831-090000/inbox/worker-demo/20260831T095500000-0009-orchestrator.json` |

The damaged message is a written file truncated to 96 bytes. The legacy
reader moves it to `broken/<address>/`, warns, and returns the other messages.
The legacy reader test checks this behavior.

Git does not preserve empty directories. A live store can retain an empty
`artifacts/` or a read mailbox's empty `inbox/<address>/`; they are absent
from this committed snapshot. The reader treats an absent inbox directory as
empty, and the migration test covers that input.

## Anonymization and maintenance

- Repository and worktree paths use the fictional `/workspace` root.
- Session ids are fixed UUID-shaped values.
- Message bodies and the artifact contain demonstration text.
- Contact points under `wake/<address>.json` are absent: a real one would
  carry a socket address and a live session token. The recorded health entries
  retain only fingerprints of placeholder `/tmp/promptobus-demo/` sockets.
- `waits/`, `stalls.json` and `.lock/` were not captured. The migration
  test adds the adapter files it needs to a copy through the store API.

Before changing a consumer, check the frozen input from the repository root:

```sh
node test/promptobus-legacy-fixture.test.mjs
node test/promptobus-migration.test.mjs
```

The snapshot files themselves are not edited to make either test pass.
