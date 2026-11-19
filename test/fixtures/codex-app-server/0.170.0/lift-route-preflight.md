# Full-lift route preflight: stopped before dispatch (2026-11-19)

Code under test: `f890233f885cbfe85c0431bcc870ba0443dd9f28`. Executable:
`/opt/homebrew/Caskroom/codex/0.170.0/bin/codex`, `codex-cli 0.170.0`, SHA-256
`9248cfeebec9b4cc3034d5114caab10fbf426cbfa79dba410c5fa1b72762abd6`.
**No credential-free route to the recording provider was established.** Neither
worker nor reviewer was lifted. The earlier direct-thread result is not a full lift.

## Setup

`$R` denotes a newly allocated, owned temporary directory. `HOME=$R/home`,
`TMPDIR=$R`, `PROMPTOBUS_CODEX_HOME=$R/registry`, synthetic owner `$R/owner`.
The three private stores under `$R/promptobus-codex-homes` were allocated separately
with `participantCodexHome` for task `qualification` and addresses `control`, `worker`,
`reviewer`. `makeParticipantHome` wrote `codexHomeConfig` with the servers and trusted
paths below. No private config was patched, no `auth.json` was present. The native
processes received an allowlist environment. There were no credentials or subscriptions.

Worker cwd was `worker/` inside the disposable `ancestor/` Git repo; the reviewer
preflight used a separate synthetic cwd. Each project config requested:

```toml
model_provider = "fixture"
cli_auth_credentials_store = "file"
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:62618/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
```

`OPENAI_BASE_URL` pointed to the same listener. The ancestor project also declared
the stdio `promptobus-probe` with `ORIGIN=ancestor`; participant home configs declared
the same key with `ORIGIN=workspace`. Both point to the [inert marker server](marker-server.mjs).
Control home: no MCP entry; trust both the ancestor and cwd. Participant homes: trust
only the respective cwd, as for a fresh worker or reviewer. The controlled difference
shows discovery, not a precedence rule for two simultaneously trusted sources.

## Observations

1. Exact-endpoint network preflight: `sandbox-exec` rejected the literal remote IP
   `127.0.0.1:62466` with `host must be * or localhost in network address`, exit 65,
   before Codex started. The fixture listener saw zero requests. No broader network
   permission was substituted. Remaining **offline** checks used `(deny network*)`,
   denied access to the real home and denied lookups of SecurityServer/securityd/secd.
2. Under those restrictions `codex --version` exited 0. For each input, run
   `codex mcp list --json` and `codex --dangerously-bypass-hook-trust app-server --stdio`
   with `CODEX_HOME` set to that private store. The latter is the holder's actual argv.
   RPCs: `initialize`, `initialized`, `config/read {cwd, includeLayers:false}`,
   `account/read {refreshToken:false}` and, for the two participant preflights,
   `model/list {includeHidden:true}`. No thread or turn was started.

| Input | `mcp list` / `config/read` marker | Provider / account | Model list | CLI / app exit |
|---|---|---|---|---|
| Trusted ancestor, no workspace entry | `ancestor` / `ancestor` | null / null; auth required | not requested | 0 / 0 |
| Worker | `workspace` / `workspace` | null / null; auth required | `gpt-6-astra` present, 14 entries | 0 / 0 |
| Reviewer | `workspace` / `workspace` | null / null; auth required | `gpt-6-sol` present, 14 entries | 0 / 0 |

In the trusted control and reviewer cwd Codex reported `Ignored unsupported project-local
config keys ...: model_provider, model_providers`. In the worker cwd Codex reported that
the ancestor project layer was not trusted. No effective fixture provider/base URL was
returned; `requiresOpenaiAuth` was true in all three replies. A model name in the list
is not evidence of routing. The production private-home writer emits no provider table
and the holder does not pass a provider override in argv. The fixture did not inject a
user-level provider table or try the default provider to discover where it would send.

## Accounting and cleanup

Recording listener `127.0.0.1:62618`: zero HTTP requests. Both roles: **0 lifts,
0 thread starts, 0 turn starts, 0 Responses requests**. No actual provider route
observed. Model-facing descriptors, canonical body selection, lifted tool inventory,
MCP handshake and reviewer write denial are all unmeasured on the full-lift path.
The positive ancestor control is at discovery level only. No real model read a skill.

All three offline app-server processes exited 0 after EOF. Both fixture listeners
closed and neither port had a listener on readback. Removed only the owned `$R`
after checking its fixture marker; directory absence verified. No general gates ran.
