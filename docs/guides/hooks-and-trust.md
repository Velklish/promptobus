# Hooks, trust, and troubleshooting

Project hooks give the orchestrator two things: a line in the session after bus mail, and a Stop guard that refuses to end a turn with unread mail. Participant worktrees get their own Stop hook from the driver. This guide is for Claude Code, Cursor, and Codex.

Install first: [install.md](install.md).

## What the installer edits

Only project files next to `promptobus.json`:

| Harness | File | Owned records |
|---|---|---|
| Claude Code | `.claude/settings.json` | `PostToolUse` matcher `mcp__promptobus__(promptobus_send\|promptobus_mailbox)`; `Stop` and `SessionStart` running `promptobus guard` |
| Cursor | `.cursor/hooks.json` | `postToolUse` that returns `additional_context`; `stop` running `promptobus guard` |
| Codex | `.codex/hooks.json` | `PostToolUse` that returns `systemMessage`; `Stop` running `promptobus guard` |

The generated runner is `.promptobus/hooks/bus.mjs`. `src/hooks.ts` plans the Claude-shaped settings. The installer maps that plan onto each harness file.

Owned records are identified by the stable command and matcher, not by file position. A later install with a shorter `--harnesses` list deletes owned records of the harnesses you dropped. Foreign groups stay.

## What is never touched

- `~/.claude`, `~/.cursor`, `~/.codex` — user-level harness homes
- Foreign hook groups and unknown fields in the project files
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

The installer does not bypass harness trust. After a successful write the CLI prints `configured` and the checks for that harness.

**Claude Code.** Project hooks in `.claude/settings.json` run only when this workspace is trusted. Approve the project when the harness asks. The Stop hook is `promptobus guard`. A clean mailbox exits 0 and prints nothing. Unread mail exits 2 and returns the turn.

**Cursor.** Project hooks live in `.cursor/hooks.json`. Trust the workspace hooks when Cursor asks. Bus feedback arrives as `additional_context` on `postToolUse`. The loop guard is `stop`.

**Codex.** Review the new project hooks with `/hooks` before you rely on them. Bus feedback arrives as `systemMessage` on `PostToolUse`. Project hooks also depend on trusting this workspace.

If you skip trust, spawn still works. You lose the tape line and the Stop guard. The warden can still knock. `promptobus_mailbox` is still the source of truth.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `promptobus help` has no `install` | The installer is not in this CLI yet. Do not hand-copy hook JSON from another machine. Wait for the command or call `planPromptobusHooks` from `promptobus/hooks` in your own installer. |
| `--harness X` refused | `X` is not in `promptobus.json` `tools`. Add it. Do not invent a `tools add` command — this CLI has none. |
| MCP tools missing | The session has no `promptobus` stdio server, or `PROMPTOBUS_HOME` is wrong. Compare the path with `promptobus status`. |
| Foreign mailbox header | You resolved another task. Pass `task` to the tool, or `promptobus_mailbox` with `claim: true` if this is your task and a new session. |
| Stop hook loops | Guard returns 2 at most twice on the same unread set, then warns and lets the turn end (`lib` guard). Empty the mailbox. Do not delete the Stop hook to "fix" a loop. |
| Warden silent | `PROMPTOBUS_WARDEN=off`, or the participant has no contact point (`self-wake` in `promptobus status`). Mail is still in the mailbox. Call `promptobus_mailbox`. |
| Worker worktree has no Stop hook | The driver writes that hook at spawn, not `promptobus install`. Re-spawn the participant. |
| Partial hook file after a crash | The installer must refuse a malformed file and write nothing. Restore the file from git and run `promptobus install --check`. |
| Home-directory hooks changed | That is a bug. Project install never writes under `~/.<harness>`. Report it with the path and a diff. |

Postcard text is a copy, not a read. Only `promptobus_mailbox` marks mail read. If a knock repeats, the mailbox still has unread items.

## Related

- Command form: [install.md](install.md)
- Host boundary: [../adr/adr-002-standalone-host-contract.md](../adr/adr-002-standalone-host-contract.md)
- Orchestrator skill: [../../skills/orchestrate/SKILL.md](../../skills/orchestrate/SKILL.md)
