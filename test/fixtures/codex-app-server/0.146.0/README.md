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
claim a tool-list result. No `turn/start` was sent.
