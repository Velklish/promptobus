# ADR-029 · Enforce BB review through a constrained Codex provider

**Status:** Accepted
**Date:** 2026-10-08

## Context

BB 0.45.0 / Plugin SDK 0.6.15 exposes accept-edits, auto and full permission modes.
The public thread creation contract has no per-role read-only sandbox or global
tool deny field. Plugin agent configuration selects only that plugin's own tools.
Selecting the built-in Codex provider therefore cannot establish the existing
read-only reviewer contract.

## Decision

Promptobus owns a small Codex reviewer provider in its BB plugin. It runs Codex
app-server in a private home and an empty project sandbox, forces read-only with
approval policy never, disables Apps and plugins before initialization, disables
execution and hooks, and verifies the effective
profile before any turn. Effective startup configuration must confirm disabled
features and no MCP servers, including managed configuration. Only the four bounded review file tools enter its dynamic
tool inventory. Unknown tool calls are denied before BB dispatch. All external MCP
tools remain unavailable until an authoritative read classification admits them.

BB owns environment and bridge lifecycle. The provider owns its Codex child only.
An interrupt waits for the native terminal event before a successful Stop reply;
an unacknowledged interrupt or a missing terminal event times out after five seconds
and closes the child. Unexpected native exit fails the open turn and releases its
executor. Shutdown also cancels catalog queries and refuses new sessions or queries.
Stop reserves its executor before awaiting native acknowledgement, refuses new turns
during that wait, and validates a known active turn before cleanup. A stale Stop cannot
close a different active turn. Native exit is handled even before turn acceptance;
refused turn input never publishes buffered assistant items.
Read tools run on the local coordinator host and derive their roots from the
SDK's authenticated thread and environment, never mutable plugin metadata.

## Consequences

The built-in BB Codex provider is unsupported for the reviewer role. Other roles
can still use it under their own contracts. A native external reviewer is a mixed
runtime pilot and does not establish full BB support. Full integration requires
live role, lifecycle, Host delivery and permission evidence for the actual profile.
The constrained provider does not change native Promptobus reviewers.

## Permission proof

The measured profile is BB 0.45.0, SDK 0.6.15, Codex CLI 0.162.0-alpha.2,
model gpt-6.1-sol with low effort, on one local macOS host. The provider refuses
another Codex version before creating a thread. Public SDK spawn/configuration
can select plugin tools but does not enforce provider-wide read-only restrictions.

The initial test exposed a real gap: an isolated Codex home and a filtered dynamic
tool list still loaded account Apps. A `McpToolCall` to
`chatgpt_space.create_space` returned `isError: false`. The disposable resource
has id `page_space_9063630fc0f881919d42fd1b77c7e98c`. No delete API was available
in the connected tool inventory; this test resource needs manual removal.

The corrected live test disabled Apps, plugins and remote plugins at process
startup. Thread `thr_3syc6mietp` completed; raw tool output listed only `apply_patch`, `clock__curr_time` and the four bounded
review tools. There was no shell or external write tool. `pb_review_read_file` returned the source; the outside-root
read returned `Path is outside the declared review roots`. The built-in
`apply_patch` remains exposed and returned `patch rejected: writing is blocked by
read-only sandbox; rejected by user approval settings`. A subsequent bounded read
and Git status both verified the canary remained `UNCHANGED`. These are native
tool outcomes, not only the reviewer's final assertion. No external mutation was
attempted in the corrected test.

Commands (all exit 0): `bb --version`, `codex --version`,
`bb plugin build`, `bb plugin reload promptobus`,
`bb thread wait thr_3syc6mietp --status idle --timeout 30s --json`,
`bb thread output thr_3syc6mietp --json`, and
`git -C /private/tmp/pb-bb-review-live-uzpktrh8 status --porcelain`.
The spawn used project `proj_97yymqqsrr`, environment `env_3e6c2g4dsy`,
`--provider promptobus-codex-reviewer --model gpt-6.1-sol --reasoning-level low
--permission-mode accept-edits`, and a prompt restricted to local canary mutation
and tool inventory inspection. Fixture tests additionally submit forged shell,
edit and canonical write requests and assert three JSON-RPC denials before BB
dispatch. A full BB profile remains gated on role workflow, authoritative binding,
Host delivery and recovery evidence.
