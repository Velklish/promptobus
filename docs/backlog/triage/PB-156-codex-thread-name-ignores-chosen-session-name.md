# PB-156 · The Codex thread is named `promptobus:<task>:<address>`, so the readable session name the mechanism already chose and stored is invisible in the Codex UI

- **Scope:** `lib/codex-session.js`, `lib/driver-codex.js`, [02-host](../../reference/02-host.md), Codex session tests
- **Created:** 2026-09-07
- **Dependencies:** none

## Context

The mechanism chooses a readable session name for every participant. `sessionName` (lib/spawn.js:465-472) builds `Worker: <slice title> (<MMDD-HHMM>)` — `Review:` for a reviewer — and appends the worker slug only when two participants of one task collide. Its own comment states the purpose: "`title` is the title of the work SLICE, otherwise sessions of one task are indistinguishable in `claude agents`" (lib/spawn.js:462-464). The name is computed at lib/spawn.js:751-757 and written to the participant journal.

The Codex path never uses it. `lib/codex-session.js:967` builds its own string and sends that to the harness:

```js
const threadName = `promptobus:${record.task}:${record.address}`;
const named = await rpc.request('thread/name/set', { threadId: state.threadId, name: threadName }, NAME_SET_TIMEOUT_MS);
```

The session record the holder is handed (lib/driver-codex.js:395-421) carries `task`, `address`, `model`, `prompt`, `argv` and the rest of the launch context, but no name field at all — so the chosen name is not merely overridden, it never reaches the driver.

Observed live on task `pb-qprep-t20260907-160618`, a Codex worker lifted 2026-09-07. The journal holds the readable name:

```
"id": "worker-promptobus", "harness": "codex",
"sessionRef": "Worker: Q-prep: gates, hygiene, exec ceilings (0907-1606)"
```

The Codex session list for the same participant shows `promptobus:pb-qprep-t20260907-160618` over the worktree directory `promptobus-pb-qprep-promptobus-t20260907-160618` — a task id above a directory name, with nothing saying what the session is working on. The one thing the naming convention exists to deliver, "what work is this session doing, without entering it", is exactly what is missing; two Codex workers on the same task differ only by the address tail.

This is not the documented `naming` seam. `src/driver.ts:255-261` declares `naming` as "what this harness calls the session **when the mechanism does not choose the name**", and the Codex declaration (lib/driver-codex.js:68) speaks only about the thread **id**: "the thread id is chosen by app-server itself and printed on lift". The id is indeed the harness's; the display name is not — `thread/name/set` exists and the code already calls it successfully. The Claude driver passes the chosen name straight to the binary (`'--name', ref`, lib/driver-claude.js:680); Cursor genuinely cannot (lib/driver-cursor.js:252 — the persist session name is invented by the agent), which is why its declaration reads as it does. Codex sits between them and takes Cursor's outcome while having Claude's capability.

Not already tracked: `grep -rniE 'thread/name|threadName|session name|sessionName' docs/backlog/queue docs/backlog/deferred docs/backlog/triage` hits only PB-151, which is about the file mode of the Cursor wake buffer.

## Work to do

- Carry the chosen session name into the Codex session record at lift (lib/driver-codex.js:395-421), the same channel `task` and `address` already travel by, and use it as the `thread/name/set` argument at lib/codex-session.js:967 instead of the assembled machine string.
- Keep the machine identity addressable: the record already holds `task` and `address`, and the wake path finds a session by them, not by the display name. Confirm no lookup reads `threadName` back before changing it.
- Fall back to today's `promptobus:<task>:<address>` when no name reached the record — an older record written by a previous version has no such field.
- Correct the `naming` declaration (lib/driver-codex.js:68) so it speaks only about the thread id, which really is the harness's to choose, and update the host reference section that describes how a participant session is named.

## Out of scope

- The Cursor persist session name — the agent invents it and the mechanism has no seam to set it (lib/driver-cursor.js:252). This entry is about a harness that accepts a name and is not given one.
- The worktree directory and branch names — machine names by design (`promptobus-<task-slug>-<worker-slug>-t<date>-<time>`), unrelated to the display name.
- Renaming a live thread after lift, and any change to `nameSet` diagnostics (lib/driver-codex.js:328, :348) beyond keeping them working.

## Verification

- Lift a Codex participant with a known `--title` and read the session record: the name sent to `thread/name/set` equals the `sessionRef` in the task journal — `Worker: <title> (<MMDD-HHMM>)` — not `promptobus:<task>:<address>`.
- A record without the name field still lifts and is still named, by the current machine string; a test that reddens if the fallback is removed.
- Two Codex workers on one task lift under distinct names, differing by their `--title` rather than by an address tail.
- `npm test` stays green.
