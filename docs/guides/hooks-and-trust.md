# Hooks, trust, and troubleshooting

Project hooks give the orchestrator a line in the session after bus mail where the harness supports it, and a Stop guard that refuses to end a turn with unread mail. Cursor receives bus feedback by driver injection rather than a project hook. Participant worktrees get their own Stop hook from the driver. This guide is for Claude Code, Cursor, and Codex.

Install first: [install.md](install.md).

## What the installer edits

Only project files next to `promptobus.json`:

| Harness | File | Owned records |
|---|---|---|
| Claude Code | `.claude/settings.json` | `PostToolUse` matcher `mcp__promptobus__(promptobus_send\|promptobus_mailbox)`; `Stop` and `SessionStart` running `promptobus guard` |
| Cursor | `.cursor/hooks.json` | `stop` running `promptobus guard` only |
| Codex | `.codex/hooks.json` | `PostToolUse` (runner field `systemMessage`); `Stop` and `SessionStart` running `promptobus guard` |

The generated runner is `.promptobus/hooks/bus.mjs`. `src/hooks.ts` plans the Claude-shaped settings. The installer maps that plan onto each harness file.

Owned records are identified by exact install ids first, not by file position. Guard records without a manifest id use the portable command signature described in [install.md](install.md); bus feedback uses its matcher. A later install with a shorter `--harnesses` list deletes owned records of the harnesses you dropped. Foreign groups stay, except guard-shaped commands described in [install.md](install.md).

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

**Codex.** Review the new project hooks with `/hooks` before you rely on them. The runner default field is `systemMessage`. Project hooks also depend on trusting this workspace.

If you skip trust, spawn still works, but project hooks do not run: Claude Code and Codex lose their tape line, and each harness loses its project Stop guard. Cursor bus feedback is the separate driver-injection path. The warden can still knock. `promptobus_mailbox` is still the source of truth.

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
