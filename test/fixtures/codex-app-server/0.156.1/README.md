# Codex app-server 0.156.1 fixtures

Generated on 2026-09-25 with:

```text
codex app-server generate-json-schema --out <dir>
```

The command was run with `codex --version` reporting `codex-cli 0.156.1`, and exited 0
with 39 entries. This directory keeps the approval request and response schemas and the
`ServerRequest` method list from the [0.146.0 directory](../0.146.0/README.md),
plus the `requestUserInput` response schema used by the Codex stand, copied byte for byte. It
intentionally does not include the generated `ClientRequest` schema or unrelated protocol
schemas.

`ToolRequestUserInputResponse.json` was added from the same 0.156.1 generator on
2026-09-25. The stand compiles it with the approval replies so the holder's answer stays
schema-valid.

What changed against 0.146.0, compared as parsed JSON with the `description` fields left out:

- `ReviewDecision` in `ExecCommandApprovalResponse` and `ApplyPatchApprovalResponse` gained
  `approved_mcp_policy_amendment`. The other arms are all still there, at shifted `oneOf`
  positions. The holder answers by value, so the shift does not reach it.
- `CommandExecutionRequestApprovalParams` gained `kind`: `command` or `writeStdin`, default
  `command`. The holder decides both the same way. `writeStdin` needs the
  `write_stdin_approval` feature, which `codex features list` prints as `under development`
  and `false`.
- Path fields moved from `AbsolutePathBuf` to `LegacyAppPathString`. Both are plain strings.
- `ServerRequest` names the same ten methods. Two definitions changed shape.
  `McpServerElicitationRequestParams` gained an `openaiForm` mode. `ToolRequestUserInputParams`
  gained a required `isBlocking`.
- `FileChangeRequestApprovalParams` did not change. It still carries no target path, and the
  live capture below confirms it.

`McpServerStatusList-0.156.1-2026-09-25.json` re-takes the override-form probe of 2026-09-10.
No turn was started. `initialize` and `thread/start` accepted a `config.mcp_servers` entry with
`disabled_tools`, and the server reported `ready`. The thread-scoped `mcpServerStatus/list`,
asked right after `ready`, replied this time, about 1.1 s later. Its inventory for the probe
server was `read_tool` alone. The same reply listed a second server that nobody configured:
`codex_apps`, connected, with 52 tools.

`DisabledToolsEnforcement-0.156.1-2026-09-25.json` re-takes the enforcement probe of
2026-09-11 on the shipped form. No turn was started. There were two homes, differing only in
`disabled_tools`. The server was asked `tools/list` in both and answered with both tools. The
thread inventory held `read_tool` alone with the key and both tools without it: the same answer
as on 0.146.0. The record also lists the `codex_apps` tools found in both branches. They come
from the `apps` feature, stable and on by default. A home that sets `[features] apps = false`
lifts no such server. The participant home now sets that key; see
[05-drivers](../../../../docs/reference/05-drivers.md#the-built-in-codex_apps-server-stays-off-in-the-participant-home).
No paid turn was spent on this record. The two spent on 2026-09-11 are in the 0.146.0 record.

`TokenUsage-0.156.1-2026-09-25.json` is the `event_msg.token_count` record of a one-word
`codex exec` turn in a disposable home. It keeps both usage objects with their six token fields,
`model_context_window` and the `rate_limits` shape. The thread id, the timestamp and the plan
type are left out. On this build the rollout also writes a `token_usage_record` line with the
same six fields, and `task_complete` carries `duration_ms` and `time_to_first_token_ms`. Neither
is part of this record.

The live file-change approval of 2026-09-25 is not a file here. It is recorded in
[03-cli § The Codex holder](../../../../docs/reference/03-cli.md#the-codex-holder). A worker
lifted by the mechanism with `workspace-write` got an out-of-root `apply_patch`. That raised
`item/fileChange/requestApproval` with `threadId`, `turnId`, `itemId`, `startedAtMs`, `reason`
and `grantRoot`, and no path.
