# Participant configuration — macOS arm64, 2026-11-19

Executable: `/opt/homebrew/Caskroom/codex/0.170.0/bin/codex`, SHA-256
`9248cfeebec9b4cc3034d5114caab10fbf426cbfa79dba410c5fa1b72762abd6`;
`--version` → `codex-cli 0.170.0`, exit 0. The consumed protocol capture independently
selects 0.170.0. Its `ThreadStartParams.config.additionalProperties` is `true`.

## Private TOML parser

`codex mcp list --json` from a synthetic cwd, with fresh HOME and CODEX_HOME and no
inherited credentials. The macOS sandbox denied network and access to the user's home.
The input came from `codexHomeConfig`. Paths below are relative to temporary fixture roots.

| Input | Output | Exit |
|---|---|---:|
| `mcp_servers`: stdio and HTTP | JSON transports `stdio` (`command`, `args`, `env` with the workspace marker) and `streamable_http` (`url`, `http_headers`, `env_http_headers`, `bearer_token_env_var` with the supplied values) | 0 |
| Rename the only stdio `command` to `renamed_command` | `invalid transport` at `mcp_servers.promptobus-probe` | 1 |
| Valid `features.apps=false`, `features.hooks=false`, `features.code_mode.direct_only_tool_namespaces=["functions"]`, `disabled_tools=["write_tool"]`, `projects.<path>.trust_level` trusted and untrusted | JSON server list | 0 |
| Replace `apps` or `hooks` with integer 34, independently | `expected a boolean` in `features` | 1 each |
| Set `direct_only_tool_namespaces` to 34 | `did not match any variant of untagged enum FeatureToml` in `features.code_mode` | 1 |
| Set `disabled_tools` to 34 | `expected a sequence` in `mcp_servers.probe.disabled_tools` | 1 |
| Replace `trusted` with `typo` | `expected trusted or untrusted` at the project trust level | 1 |
| Replace `apps=false` with `unknown_probe=false` | JSON server list | 0 |

The last control is why a successful load alone cannot certify vocabulary. No HTTP
handshake, project trust policy, raw-tool dispatch or hook delivery was tested here.

## Synthetic thread and tool boundaries

`codex app-server --listen stdio:// -c 'cli_auth_credentials_store="file"'` with the
same filesystem and network restrictions. A fixture Responses provider pointed at
`http://127.0.0.1:1/v1`. Without the fixture provider, `thread/start` timed out at 12 s
for all three profiles; those attempts established no thread result. No `turn/start`.

One synthetic HOME (`home`); CODEX_HOME was `home/.codex`, `worker/private` or
`reviewer/private`. All used the same MCP key `promptobus-probe`; the two stdio
server configurations returned different origin markers. The calls, in order:
`initialize` (experimental API), `initialized`, `skills/list` (cwd, force reload),
`thread/start` (ephemeral, approval never), `mcpServerStatus/list` (thread ID, full),
`mcpServer/tool/call` for each marker read tool and the inert `write_tool`.

| Profile | Pre-start skill descriptors (fixture names only) | Connected server, enumerated tools and call results |
|---|---|---|
| Worker, `gpt-6-astra`, workspace-write | `collision` twice (repo canonical, user personal), user `unrelated` | workspace only; `workspace_read`, `write_tool` each returned `workspace:<tool>` |
| Reviewer, `gpt-6-sol`, read-only | `collision` twice (private canonical and personal, both user), user `unrelated` | workspace only; `workspace_read` returned `workspace:workspace_read`; `write_tool` absent and call refused with -32603, `tool 'write_tool' is disabled for MCP server 'promptobus-probe'` |
| Outside before and after, no override | personal `collision`, personal `unrelated` | personal only; `personal_read`, `write_tool` each returned `personal:<tool>` |

Both role replies reported `reasoningEffort: high` for `model_reasoning_effort=high`.
Both requests included `bypass_hook_trust=true`, and the reviewer included
`features.shell_tool=false` and `features.unified_exec=false`. A successful start does
not establish hook trust or shell suppression. The install-root `features.hooks=false`
thread override was not exercised. No model reasoning was measured.

`skills/list` returned physical paths under `/private/var` while the canonical directory
was supplied under `/var`. Before the fix neither request included `skills.config`.
Afterwards each sent exactly `[{path: <physical HOME>/.agents/skills/collision/SKILL.md,
enabled: false}]`. This establishes override construction and an accepted start, not
the effective model-visible skill list or content. This was a direct app-server stand
using the production config builders, not an end-to-end participant lift. Other MCP
sources and full worker/reviewer model turns were not qualified. Outside, worker and
outside-after app-servers exited 0; reviewer replies completed before teardown needed
SIGKILL at the 2 s EOF deadline.
