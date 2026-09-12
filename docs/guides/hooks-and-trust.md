# Hooks, trust, and troubleshooting

Project hooks are one thing: a Stop guard that refuses to end a turn with unread mail. Participants get their own, written by the driver into the directory they work in — see [A participant's hooks are not the workspace's](#a-participants-hooks-are-not-the-workspaces). This guide is for Claude Code, Cursor, and Codex.

There used to be a second one — a `PostToolUse` line echoing each bus call back into the session. It is gone, and an install removes it where an earlier one wrote it. Nothing of the working machinery ran through it: the turn is returned by the Stop guard, unread counts ride in the MCP reply itself, and delivery to a participant is the warden's over its own channel.

Install first: [install.md](install.md).

## What the installer edits

Only project files next to `promptobus.json`:

| Harness | File | Owned records |
|---|---|---|
| Claude Code | `.claude/settings.json` | `Stop` and `SessionStart` running `promptobus guard` |
| Cursor | `.cursor/hooks.json` | `stop` running `promptobus guard` only |
| Codex | `.codex/hooks.json` | `Stop` and `SessionStart` running `promptobus guard` |

`src/hooks.ts` plans the Claude-shaped settings; the installer maps that plan onto each harness file. Nothing generates a runner script any more. `.promptobus/hooks/bus.mjs` is the path an install still knows, because it is how it recognises and deletes a feed hook an earlier version wrote — and it deletes the script with it.

Owned records are identified by exact install ids first, not by file position. Guard records without a manifest id use the portable command signature described in [install.md](install.md); a leftover feed hook is recognised by the runner path its command still names. A later install with a shorter `--harnesses` list deletes owned records of the harnesses you dropped. Foreign groups stay, except guard-shaped commands described in [install.md](install.md).

## A participant's hooks are not the workspace's

`promptobus install` writes hook files at the **workspace root**. A participant never works there: a worker's directory is its worktree and a Codex reviewer's is a sandbox of its own, so a hook file at the root is not a project file for either of them. The driver therefore writes the participant's own, into the directory that participant works in, carrying that participant's identity (`--role`, `--task`, `--home`) where the workspace's own guard carries none.

For Codex that directory is also the only project the participant trusts: the lift records `[projects."<realpath of the working directory>"]` in the participant's home, and nothing else. So the hooks file goes beside the skills copy, in `.codex/` of the working directory, under the same self-ignoring `.gitignore` that keeps a worker's diff clean.

**Measured 2026-09-12 on a live Codex reviewer, and the file alone is not enough.** The turn ran end to end — 45 journal lines, `thread/started`, `turn/started`, three `item/*` pairs — with the hooks file in the reviewer's working directory carrying its `--role`, and that directory named `trust_level = "trusted"` in the participant's home. No `hook/*` event of any kind appeared: `grep -c "hook/started"` was 0. The run does **not** distinguish a wrong location from the right one with hooks not enabled — `--dangerously-bypass-hook-trust` waives trust for *enabled* hooks, so enablement is a second gate and it was not tested. One thing it does rule out: the workspace-root file was not read either, since the guard there carries no `--role` and no such command ran. The file stays where it is because removing it would undo correct work if the gate turns out to be enablement rather than place.

## What is never touched

- `~/.claude`, `~/.cursor`, `~/.codex` — user-level harness homes
- Foreign hook groups that are not guard-shaped, and unknown fields in the project files
- Hooks that are not owned by Promptobus
- The participant worktree's main tree outside the hook the driver writes
- `.promptobus/hooks/` during ordinary task cleanup — the runner must stay

`uninstall` is the same rule in reverse: owned Promptobus records only.

## How to verify

```bash
promptobus install --check
```

`--check` does not repair. Non-zero exit means project files drifted from the last install. Re-run `promptobus install` (no flags, or the same `--harnesses` list) to write them again.

```bash
promptobus install --dry-run
```

Prints the plan. Writes nothing. Use it before the first write.

Idempotence: a second install with the same list must not change bytes. If `--check` is red after a no-op install, the merge is wrong — file a finding, do not hand-edit the matcher.

From a subdirectory of the workspace, hooks still run against the workspace root the host found. If they do not, `promptobus.json` is missing above you, or `PROMPTOBUS_HOME` points at another store.

## How to trust

The installer does not bypass harness trust. After a successful write the CLI prints `configured` and:

```text
Review: Codex requires /hooks; project hooks also depend on workspace trust.
```

**Claude Code.** Project hooks in `.claude/settings.json` run only when this workspace is trusted. Approve the project when the harness asks. The Stop hook is `promptobus guard`. A clean mailbox exits 0 and prints nothing. Unread mail exits 2 and returns the turn.

**Cursor.** Project hooks live in `.cursor/hooks.json`. Trust the workspace hooks when Cursor asks. Bus feedback reaches a Cursor participant by driver injection, not a project hook. The loop guard is `stop`. Cursor does not recognise `postToolUse`; adding it or another unknown event name to `.cursor/hooks.json` silently disables every hook in the file, so do not add one by hand. The installer validates the merged event map before writing and refuses an unknown event.

**Codex.** Review the new project hooks with `/hooks` before you rely on them. Project hooks also depend on trusting this workspace.

If you skip trust, spawn still works, but project hooks do not run: each harness loses its project Stop guard. The warden can still knock. `promptobus_mailbox` is still the source of truth.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `promptobus help` has no `install` | This binary was built before the hook installer merged. Do not hand-copy hook JSON. Use the `install` command from a build that lists it in help. |
| `--harness X` refused | `X` is not in `promptobus.json` `tools`. Add it. Do not invent a `tools add` command — this CLI has none. |
| MCP tools missing | The session has no `promptobus` stdio server, or `PROMPTOBUS_HOME` is wrong. Compare the path with `promptobus status`. |
| Foreign mailbox header | You resolved another task. Pass `task` to the tool, or `promptobus_mailbox` with `claim: true` if this is your task and a new session. |
| Stop hook loops | Guard returns 2 at most twice on the same unread set, then warns and lets the turn end (`lib` guard). Empty the mailbox. Do not delete the Stop hook to "fix" a loop. |
| Warden silent | `PROMPTOBUS_WARDEN=off`, or the participant is on `self-wake` in `promptobus status`. Three different things end there, and the line now says which: `starting up` is the participant not having handed over a contact point yet and clears on the first knock; a contact point held by another session clears when the address's own session takes it back; a channel that refused stays until the channel accepts. Mail is in the mailbox either way — call `promptobus_mailbox`. |
| Worker worktree has no Stop hook | The driver writes that hook at spawn, not `promptobus install`. Re-spawn the participant. |
| Partial hook file after a crash | The installer must refuse a malformed file and write nothing. Restore the file from git and run `promptobus install --check`. |
| Home-directory hooks changed | That is a bug. Project install never writes under `~/.<harness>`. Report it with the path and a diff. |

### The three `self-wake` states

The warden falls back to `self-wake` from three branches and records which one in the health mark (`selfWake`, written by the round in `src/supervisor.ts`). They share a label and nothing else, so `promptobus status` prints the prognosis after the reason:

| State | Reason it prints | Prognosis | How well it is known |
|---|---|---|---|
| `starting` | no contact point handed over | clears on the first knock | verified from a run journal |
| `taken` | the contact point is held by another session | clears when the address's own session takes it back, and not at all if that session is gone | the round expects the rewrite at that session's next end of turn, and the suite checks that delivery resumes after it |
| `refused` | the driver's channel did not accept the notification | it stays until the channel accepts | retried, so it clears if the channel returns — but nothing in the mechanism makes it return |

Only `refused` has a channel to name, and it is named the way the warden journal names it — `socket` for Claude Code, `inject` for Cursor, `rpc` for Codex.

Why the prognosis is printed at all: without it the label reads as a break in every case, and it is not one in two of them. Measured on 2026-09-10, before the field existed — the orchestrator of that run read the start-up label on its own address as a broken channel and went looking for the break.

A health record written before the field carries no `selfWake`. The prognosis is then not said rather than guessed, with one exception the wake record settles on its own: no contact point handed over at all is the start-up state whoever wrote the health file, and it is also what an address the warden has not yet reached looks like.

Postcard text is a copy, not a read. Only `promptobus_mailbox` marks mail read. If a knock repeats, the mailbox still has unread items.

## Related

- Command form: [install.md](install.md)
- Host boundary: [../adr/adr-002-standalone-host-contract.md](../adr/adr-002-standalone-host-contract.md)
- Orchestrator skill: [../../skills/orchestrate/SKILL.md](../../skills/orchestrate/SKILL.md)

## When a stall is a stall

Source: `stallStands` in `src/supervisor.ts`, the one predicate behind the warden report, the `promptobus status` print and the stalled lines in a `mailbox` reply.

Whether this is a stall for real. While the bus still had awaiting, the
participant sat inside a tool call between messages and was busy to the
harness; once awaiting was removed, they finish the turn after sending a
message, and the harness marks their session as standing with a line like
"result sent; awaiting next cycle". For stall inspection that is an
`unknown` outcome, and a report went out on every ordinary end of turn.

What remains a stall is a SILENT end of turn: the participant finished the
turn without sending anything on the bus after their last activation.
`limit` is not subject to this check at all — time lifts it, not a message
on the bus.

`permission` has a check of its own, and PB-165 is why. A harness reports a
dialog through ONE field, and it puts two different dialogs behind it: a
permission prompt of the session's own work, and a peer message the session
HELD rather than delivered — which is what the bus's own postcard becomes
when a participant is lifted in a mode that bypasses prompts. A driver's
measurement of that is in its own file, where the tool's name is allowed to
be; what belongs here is the shape it leaves: the record is identical to a
real prompt while the session runs its turn to the end and answers.

Nothing in the record tells the two apart; the bus's own marks do —*a
prompt is what SUSPENDS a turn**, so a participant that both ended its turn
and spoke after its last activation was not stopped by the dialog standing on
it (`promptStands` below). It is still deaf to that message, and the bus has
its own words for a deaf channel; what it must not do is call a person to a
session that is working.

One predicate for three callers: the warden report, the `promptobus status`
print, and the stalled lines in the `mailbox` reply. If they drifted, they
would become different answers about the same state.

The task and its store are required arguments, and they have no silent
default on purpose: "no home — treat as a stall" is exactly the divergence
mechanism the predicate was collapsed into one function to close.
/

## The warden state machine: what is here and what is not

Source: `src/supervisor.ts`.

The warden state machine: rounds, knock-retry thresholds, unread health,
silence escalation, and the decision of whom to activate.

What is here and what is not. Here — DECISIONS: who still has unread, whether
it is time to knock, which messages to show, who stalled, and who has already
been reported. There is no delivery channel here, and no text: the channel
comes from the driver via `activate`, and the same driver renders the text —
the frame and the words belong to the harness channel, not the bus. There is
also no process here: the detached launcher, the `fs.watch` observers, and the
loop live at the consumer, because a process death costs nothing by
construction — the entire state sits in the task store.

The intervals below are measured, not chosen. Changing them changes the
behaviour of a live run: each is named together with what it was measured by.

### A contact point held by a foreign session

Source: `src/supervisor.ts`.

The address's contact point is held by a FOREIGN session — or `null` if
it is held by its own, or there is nothing to compare.

This is not malice: the Stop hook takes identity from its command
arguments, and when they are missing — from the session environment, and
the harness background-session environment is not the one the session was
spawned with. Measurement 2026-09-03: harness background sessions are
pre-allocated daemon spares, and the `PROMPTOBUS_*` trio comes to them
from the process that raised the daemon, that is from the FIRST spawn of
the run. The second participant of the task then hands over a contact
point for the first address, and the warden, checking nothing, wakes a
foreign session through it: in ten minutes of that run eleven
notifications went to the wrong place.

Hence the rule: do not knock on such a contact point. It is not dead —
it leads to another session, and a knock on it starts a FOREIGN turn,
while the addressee stays deaf. This repairs itself on the first end of
turn of the real owner: their hook rewrites the record with their own.

Both sides must be named: a participant record without a session id
(spawn did not parse it from `--bg` output) and a contact point of the
former CLI without a `session` field — that is unknown, not a foreign
session, and it cannot be blamed.

### A permission prompt, or the bus's own postcard held behind the same field

Source: `src/supervisor.ts`.

Whether a dialog mark is a permission prompt the participant is standing at,
or the bus's own postcard held behind the same field (PB-165).

**Two marks have to agree, and neither alone lifts the stall.** A participant
whose dialog is the held postcard never saw the message: it carried on with
the turn it was in, reached the end of it, and reported — so after its last
activation the bus has BOTH its end-of-turn mark and a message from it. A
participant standing at a prompt of its own work has neither: the prompt is
what suspends the turn, so the Stop hook has not run and nothing was sent.

The conjunction is deliberately narrower than either half. The end-of-turn
mark alone would read the stand's play of a dialog — which runs the guard —
as a held message; a sent message alone would silence a real prompt hit later
in a turn that had already spoken. What is left open is a turn begun without
an activation: the bus does not start one, and a person who does is at the
session already.

Missing marks keep the stall, each for its own reason: no end-of-turn mark
means the participant has never yielded a turn, and reading that absence as
"carried on" would silence the very first prompt of a run; a participant
record too broken to read messages from has no right to lift its own report.

### The warden is a process, not a state machine

Source: `lib/warden.js`.

The task warden is a PROCESS, not a state machine.

Listening on the bus is held by a process, not by model discipline: the warden is
the only listener of every task mailbox and its only activator. On unread mail it
wakes the addressee and thereby starts their turn. The process has no state of its
own — everything lives in the task store, so its death loses nothing, and any CLI
command may start it again (`ensureWarden`).

**This file does not make the decisions.** Rounds, knock-retry thresholds, unread
health, silence escalation, stall resolution, and the "whom to activate" decision
live in the package ([supervisor.ts](../../src/supervisor.ts)) and know nothing about
the harness. What remains here is exactly what belongs to the harness and the
workspace: a detached process, `fs.watch` watchers, a session snapshot through the
driver registry, human diagnostics, and the loop. The delivery channel is the
driver, and it is taken from the registry
([drivers.js](../../lib/drivers.js)).

Delivery is best-effort: the "delivered" mark is one, the mailbox is claimed. An
activation refusal does not kill the process: the participant is marked with the
`self-wake` channel, and delivery to the rest continues.
