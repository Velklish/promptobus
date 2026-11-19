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

## Holder field inventory

The schema check covers the consumed protocol, not the vocabulary inside `config`.
The private TOML inputs and type controls are listed above; this table covers the
separate request path, including keys appended after `threadStartConfig` returns.

| Request input | Evidence and limit on 0.170.0 |
|---|---|
| `cwd`, `model`, `sandbox`, `approvalPolicy`, `config` | Common holder fields. The replay sends these on a fresh thread. Its approval policy is `never`, not the lift's `on-request`. `ephemeral` is a stand option. `test/codex-launch-profile.test.mjs` tests rejection of mismatching native replies with a fixture. |
| `config.model_reasoning_effort` | Both thread replies reported the requested `high`. This does not measure inference. |
| `config.bypass_hook_trust` | Both requests set it to true. No marker hook fired as a test of delivery or trust bypass. Not a private TOML parser measurement. |
| `config.features.hooks` (literal dotted key) | Install-root roles send false. Only the separate private TOML `[features] hooks` type check ran; neither the install-root request nor hook suppression was measured on this binary. |
| `config.features.shell_tool`, `config.features.unified_exec` (literal dotted keys) | The reviewer sent false for both. Neither shell tool inventory nor a shell execution decision was measured. The MCP write refusal exercises neither facility. |
| `config['skills.config']` entries `path`, `enabled` | Asserted against the exact physical path from the synthetic listing; `enabled: false` targets the colliding user copy only. Model-visible descriptors and selected content remain unmeasured. |
| `config['features.stable_environment_tools']`, top-level `experimentalRawEvents` | Fresh raw-receipt lifts send false and true respectively. `test/codex-raw-tool-profile.test.mjs` checks the production holder request against a stub for selected and default profiles. The direct threads here did not select raw receipts. Neither key's installed runtime effect is qualified; the TOML namespace parser control does not establish it. |
| `runtimeWorkspaceRoots` | Optional fresh-start field from `addDirs`. The direct threads did not supply additional roots or measure access to them. |
| `threadId`, `excludeTurns` | Resume-only holder fields; the replay did not resume. Raw receipts refuse resume before dispatch. |

## Reproduce the no-turn measurement

After `npm run build`, run on macOS with the fixture executable and Node installed
outside the personal home, from a checkout whose temporary directory is outside it:

```sh
node test/fixtures/codex-app-server/0.170.0/replay-participant.mjs /opt/homebrew/Caskroom/codex/0.170.0/bin/codex
```

The [replay](replay-participant.mjs) creates all TOML, skills and RPC inputs under a
fresh temporary root; the [stdio server](marker-server.mjs) only returns strings.
Each Codex child inherits an allowlisted environment and a macOS sandbox denying
network and access to the OS user's home. No `turn/start` is sent. The assertions
compare parser output fields, exit codes, the emitted override, server identity,
returned tool results and the reviewer's RPC error. Replacing the required TOML
`command` key must change the parser verdict from 0 to 1 (`invalid transport`).
Renaming the raw-receipt thread override must fail the separate holder fixture.

Replay results: parser exits `valid=0 stdio=1 apps=1 hooks=1 namespaces=1 disabled=1
trust=1 unknown=0`; the four skill lists, inventories and tool calls matched the
table above. Replay exit 0. EOF teardown: outside-before SIGKILL at 2 s, worker 0,
reviewer 0, outside-after 0. An EOF timeout is not a successful graceful Stop.

## Proposed full-lift check — separate authorization required

The bounded local qualification was subsequently authorized. Its [preflight receipt](lift-route-preflight.md) records why neither lift started.

Use this binary and a **local recording Responses stub**, with no account, keychain,
subscription or external endpoint. Allow loopback only to the fixture. Use one disposable
git repository and worktree, fresh synthetic HOME, owner CODEX_HOME, participant registry,
bus store and separate worker/reviewer homes. Check the outside synthetic profile before
and after without starting a turn there. Do not use a real checkout as the fixture.

1. Lift one `gpt-6-astra` worker at `high`, workspace-write, and one `gpt-6-sol`
   reviewer at `high`, read-only, both `on-request`. Record the effective thread reply.
   If the driver cannot route to the local stub or requires real authentication, stop.
2. Put distinct markers in canonical, colliding personal and unrelated skill files.
   Check the actual first Responses request of each lifted role: one canonical descriptor,
   no colliding personal descriptor, and the unrelated descriptor. Verify the listed
   canonical path resolves to the expected body. This establishes what enters the
   provider request, not what a live model reads or follows.
3. Add a third marker server with the same normalized key in an ancestor project's
   `.codex/config.toml`, in addition to the synthetic personal and participant configs.
   First show that the ancestor marker is discoverable from a trusted control cwd
   without the workspace entry. Then check the actual lifted thread's complete MCP
   inventory, origin readback and inert write allowance/denial. An undiscovered control
   is inconclusive, even if the lifted inventory looks right.
4. Budget: one `turn/start` and one local Responses request per role, two total;
   60 seconds per role, no retries, recovery turns or external fallback. Record request
   and completion counts by thread, actual model/effort, command exits and timeouts;
   any missing evidence is `notRun` or failed. No inference billing. Keep only normalized
   marker results, tool names and counts. Stop each owned holder and child, verify exit
   and removal of the registry entries, then remove the disposable worktree and stores.
   Report retained processes or paths on cleanup failure. A real inference run would
   require a separate decision; it is not part of this proposal.
