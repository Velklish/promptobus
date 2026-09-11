# Codex app-server 0.146.0 approval schemas

Generated on 2026-09-10 with:

```text
codex app-server generate-json-schema --out <dir>
```

The command was run with `codex --version` reporting `codex-cli 0.146.0`.
This directory keeps the measured approval request and response schemas and the
`ServerRequest` method list used by the Codex stand. It intentionally does not
include the generated `ClientRequest` schema or unrelated protocol schemas.

`McpServerStatusList-0.146.0-2026-09-10.json` records a no-turn probe of the
thread configuration used for the Codex reviewer's MCP deny layer. On 0.146.0,
`initialize` and `thread/start` accepted a `config.mcp_servers` entry carrying
`disabled_tools`, and the server reported `ready`. The subsequent thread-scoped
`mcpServerStatus/list` request did not reply within the bounded probe window, so
the capture records configuration acceptance and startup readiness but does not
claim a tool-list result. No `turn/start` was sent. That configuration form is no
longer the shipped one — the entries now live in the participant home's
`config.toml` (ADR-007) — so this file stands as the record of what was measured
on the override form, not as a description of the current path.

`DisabledToolsEnforcement-0.146.0-2026-09-11.json` answers what that one could
not, on the shipped form. Two threads differing only in `disabled_tools`, no
model turn: the MCP server was asked `tools/list` in both and answered with both
of its tools, and `mcpServerStatus/list` — which did reply this time, asked about
eight seconds after `thread/start` and given the same to answer — reported the
thread's inventory for that server as `read_tool` alone where `write_tool` was
disabled, and as both where it was not. The filtering is app-server's, above the
server. The capture is explicit about its ceiling: no client-visible method
returns the tool payload of the model request, so the inventory is what is
measured, not the request.

The file also records the two paid turns the owner authorised for that question,
because both were spent and neither answered it. The first was not captured — the
agent message arrived with `text: ""` and the rollout was removed before it was
read. The second fixed the capture and shows why the first looked broken: the
assistant message is genuinely empty, `task_complete` carries
`last_agent_message: null`, and 94 of 100 output tokens were reasoning. A turn
that answers nothing says nothing about the tools it was offered.
