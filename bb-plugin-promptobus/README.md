# Promptobus for BB

This plugin supplies a constrained Codex reviewer provider. The other Promptobus
BB roles and mailbox integration are not delivered by this provider alone.

## Setup

Use BB 0.45.0 and Plugin SDK 0.6.15 on one local host. Use Codex CLI 0.162.0-alpha.2 and
sign in with `codex`. The provider copies only `auth.json` into its private Codex
home; it does not modify the original authentication or copy personal config.

From this directory, run `npm ci`, `bb plugin build`, and `bb plugin install .`.
Select `Codex (Promptobus read-only reviewer)` and an explicit reported model.
The BB permission mode is `accept-edits`; the provider always requests and verifies
Codex `readOnly` with approval policy `never`, regardless of that BB label.

## Restrictions

Apps, plugins, remote plugins, shell, unified execution, hooks, subagents and
computer-use features are disabled before app-server initialization. The built-in
`apply_patch` tool remains exposed, but the native read-only sandbox rejects edits.
The provider has an empty project sandbox and an isolated Codex home with no MCP
configuration. It accepts only `pb_review_read_file`, `pb_review_read_files`,
`pb_review_list_files` and `pb_review_search_text` from BB dynamic tools.
Unclassified external tools are omitted, and forged tool calls are denied before
forwarding. Canonical MCP reads are also withheld until an explicit classification
and delivery contract admits them. Prompt text is not the enforcement boundary.

Each read uses the authenticated BB thread's actual local environment as its root.
The host entry performs bounded reads and rejects paths outside that root. Client
metadata never grants another thread access. An effective sandbox, approval or
model mismatch refuses startup before the first model turn. Unverified Codex
versions are refused; a newer version requires repeating the permission proof.
Startup also verifies the effective disabled features, private home and absence
of configured MCP servers, including managed configuration. Model and effort
changes require a fresh reviewer session.

## Lifecycle

BB owns the bridge process. A native Codex app-server belongs to each active
reviewer session. Stop releases that process; the private home remains for explicit
resume and retained session evidence. No review environment is removed here.
Models are read from the actual Codex app-server catalog. Usage windows and full
role workflow support are not claimed by this reviewer provider.
