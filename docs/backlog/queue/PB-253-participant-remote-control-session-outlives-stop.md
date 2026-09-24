# PB-253 · A participant lifted with --bg registers a Remote Control session on claude.ai, and a stopped one can stay listed there as offline for good

- **Order:** 35
- **Scope:** [03-cli](../../reference/03-cli.md) § Spawn (the participant settings file), [05-drivers](../../reference/05-drivers.md) § A stop returns after the record is gone, `lib/driver-claude.js`
- **Created:** 2026-09-24
- **Dependencies:** none
- **Cost:** major

## Context

Reported by the owner on 2026-09-24: reviewer sessions of finished runs keep showing in the session list of the desktop app (and of claude.ai) after `promptobus stop` closed them. The list in question is the account's Remote Control list, and the entries read "Remote Control · offline".

**Every session the Claude driver lifts with `--bg` registers a Remote Control session on claude.ai.** The harness does it on its own — no flag of the lift asks for it — and writes the server id into the job record: `bridgeSessionId` in `~/.claude/jobs/<id>/state.json`. Measured 2026-09-24 on claude 2.1.280: 902 of 923 job records under `~/.claude/jobs` carry the field, every participant of that day's run among them (worker, reviewer and approver alike).

**What takes the entry off the list is the harness's own teardown at process exit, and a stop does not always reach it.** Strings of the 2.1.280 binary: `[bridge:repl] Hook cleanup: starting teardown for session=… reason=host_exit`, followed by an `ArchiveSession` call; the same teardown appends a `bridge-session` record to the session transcript. Of 722 job transcripts since 2026-08-30, 678 end with that record and 44 do not. The account list held five participant sessions of past runs (four reviewers, one worker; the oldest lifted 2026-08-31), and every other participant of the same runs was gone: four of the five are among the 44 transcripts without the teardown record, the fifth carries the record with `lastSequenceNum: 0`. The reported case in full: `promptobus stop reviewer:<slug>` ran `claude stop <id>`, the driver saw the record leave `claude agents` inside its ceiling and printed `session <id> closed`, the daemon logged `bg settled <id> (killed)` — and the transcript ends without the teardown record, while during the session's last turn (a re-review) the transcript header with the `bridge-session` record was rewritten twelve times, every time with `lastSequenceNum: 0`: the bridge of that session never advanced. **Hypothesis:** the archive call never reached the server. Whether `claude stop` sends SIGTERM before SIGKILL is undocumented (the harness's tracker holds an open report of a bare SIGKILL, [anthropics/claude-code#62987](https://github.com/anthropics/claude-code/issues/62987)), and the docs promise only "offline within seconds after the process exits", never an archive.

**The participant does not need the entry.** A participant is driven over the bus — knock, mailbox, `promptobus_send` — and nobody drives it from a phone; the entry is what a person sees in a list they use for their own sessions. The docs name one switch and no per-session opt-in ([anthropics/claude-code#90874](https://github.com/anthropics/claude-code/issues/90874) is the open request for one): the setting `disableRemoteControl` — "Disable Remote Control (claude.ai/code, `claude remote-control`, `--remote-control`/`--rc`, auto-start, and the in-session toggle)" — and the binary reads it from the merged settings, which is where the participant settings file the driver already writes lands. Measured 2026-09-24 on claude 2.1.280: a `--bg` session lifted with `--settings` holding `{"disableRemoteControl": true}` got no `bridge*` field in its job record, no `bridge-session` record in its transcript, never appeared in the Remote Control list, answered its prompt, and `claude stop <id>` closed it (`stopped <id>`, exit 0).

## Work to do

- The participant settings file (`settingsFile` in `lib/driver-claude.js`) carries `"disableRemoteControl": true` for every role. The orchestrator's own session is not touched: the key lives in the participant file only.
- [03-cli](../../reference/03-cli.md) § Spawn: the paragraph on the settings file names the key and why — the five keys become six. [05-drivers](../../reference/05-drivers.md) § A stop returns after the record is gone: one paragraph on what the Remote Control entry is, that a participant never has one, and that the entries of earlier lifts are archived by hand from claude.ai or the app.
- Pin it: the settings-file checks in `test/promptobus-driver-claude.test.mjs` assert the key for worker, reviewer and approver; the review and approver lift tests keep passing.
- CHANGELOG line.

## Out of scope

- Archiving the entries already left behind: the harness has no command for it, and the bus will not call the server itself.
- Making the harness's teardown or `claude stop` reliable — the harness's tracker.
- Keeping participants reachable from a phone: if the owner wants that, this card turns into the opposite — a stop that reports the entry it may leave behind — and the flag is not written.

## Verification

- `promptobus spawn --dry-run …` and `promptobus review --dry-run …` print a participant settings object with `disableRemoteControl: true` for worker, reviewer and approver; `npm test` is green with the new assertions.
- One live lift on claude 2.1.280, any role: `~/.claude/jobs/<id>/state.json` has no `bridgeSessionId`, the transcript has no `bridge-session` record, and after `promptobus stop <address>` the session is absent from the Remote Control list of claude.ai / the desktop app.
