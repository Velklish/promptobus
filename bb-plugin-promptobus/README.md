# Promptobus for BB

This optional package owns the local BB adapter: engine-backed native tools,
authoritative participant bindings and a constrained Codex reviewer provider.
The native Promptobus CLI and harness registry keep their existing entry points.

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
`pb_review_list_files` and `pb_review_search_text` from BB dynamic tools, plus the
four explicitly classified authenticated bus tools below for bound reviewers.
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

## Role instructions

The six standing role contracts live in `skills/` and are generated from
`promptobus/instructions`. After refreshing the local package with `npm ci`, run
`npm run skills:render` when the renderer changes; `npm run skills:check` checks
the delivered text. Task, tool, environment, snapshot and gate bindings belong in
the initial prompt or declared artifacts. `createBbInstructionDelivery` constructs
that payload and a short skill selection; its caller must first authenticate the
participant. The payload builder grants no rights.

The returned configuration has `tools: []`. The caller supplies a validated list
of registered tools, for example `{ ...delivery.configuration, tools:
authenticatedToolSelection }`, before returning it from `agents.configure`.
Prompt context tool names do not perform that selection. Approver contact rules
are conditional on the supplied registered worker and assignment authorization.

The constrained reviewer bridge supplies the complete reviewer skill before the
first native turn, alongside runtime instructions. It does not place the long
contract in `agents.configure().instructions`, which BB truncates at 4096
characters. Its selected plugin skill is the same text, checked against the
exported renderer. The other role skills describe the portable contracts;
engine-backed participant binding is supplied by this package.

## Local task entry point

Build the root library before `npm ci` in this package so the local `file:..`
dependency contains its current public exports. Build and reload the installed
plugin after source changes. `bb promptobus --help` describes the operator CLI.

```sh
bb promptobus task create --task demo-t20261008-120000 --title "Demo" \
  --project proj_example --environment env_example --model gpt-6.1-sol \
  --assignment "Read the task and wait for mail."
bb promptobus participant add --task demo-t20261008-120000 \
  --participant worker-api --role worker --model gpt-6.1-sol \
  --assignment "Implement the supplied assignment."
bb promptobus bindings
```

Use real existing project/environment ids on the primary local host and a Git
coordinator environment with an actual HEAD. The coordinator must be unmanaged:
its canonical journal must outlive BB worker environment retirement. The first
command creates the canonical task and a new owner thread; the second adds a
new participant to that plugin-owned active task. Both hold the first prompt
until the returned BB thread identity is finalized. A launch failure remains
`orphan` in `bindings`; it is never silently reassigned. This CLI is a trusted
local machine-operator entry point. It does not expose a bind-existing-thread tool.

The server owns SQLite identity rows and never reads a participant filesystem.
Each tool checks the authenticated thread/project, fresh SDK provider/environment
and primary host, then calls the host entry. The host verifies the active v1 task,
participant role, adapter token and opaque sessionRef before the operation.
Mutable `pluginMetadata` and caller identity fields grant no rights. A first tool
call before finalization fails without a privileged host operation. Reload keeps
the SQLite rows; changed or missing threads/tasks/participants are refused.

| Tool | Arguments | Effect |
| --- | --- | --- |
| `promptobus_task` | `{}` | Current task, own identity and registered contacts |
| `promptobus_mailbox` | `mode: peek` or `read` | Peek retains unread refs; read ACKs only the caller's mailbox |
| `promptobus_send` | `to`, protocol `type`, `body`, optional `artifact: {filename, content}` | Engine-canonical typed send; UTF-8 artifact is streamed on the host |
| `promptobus_artifact` | artifact `id` | Current-task metadata and verified UTF-8 content, up to 1 MB |

All argument objects are strict. Sender, task and address are derived from the
binding, and cannot be supplied. Body size is capped at 2400 characters; attachment
text at 1 million characters and artifact reads at 1 MB. Reporter bindings omit
send. Routing currently goes through the task orchestrator; worker lateral sends
are refused. New role threads use built-in Codex except reviewers, which use the
constrained provider. Bus writes do not grant reviewer source or shell writes.

The six role skills are delivered, but recipient wake/recovery, model-catalog
selection and the complete role workflow are separate
integration boundaries. A send returns engine activation events; this entry point
does not yet wake recipients. BB queued first prompts are admission state, not
the canonical Promptobus mailbox.

## Verification

`npm test` uses the SDK fake host with real temporary SQLite and the exported
engine for identity/race/reload/mailbox/artifact checks. The SDK harness requires
the pinned optional testing peers in devDependencies. Build with `bb plugin build`
to verify the self-contained host bundle as well as the server. Mock SDK evidence
and actual local tool-turn evidence are reported separately.

## Lifecycle

`participant add --environment <id>` reuses an existing local environment.
`participant add --new-environment --base-branch <branch>` asks BB to create a
managed worktree. The SDK owns creation; no native Promptobus worktree name or
`git worktree add/remove` is reconstructed. Children explicitly name the owner
thread as both `parentThreadId` and `lifecycleOwnerThreadId`. Returned actual
environment id, path, branch, host and HEAD SHA are retained in plugin storage and
canonical participant metadata.

BB 0.45.0 provisions a new environment after the first prompt, not when it creates
the thread row. A bound `provisioning` phase admits only the exact nonce-bearing
preparation prompt, with no assignment, plugin tools or role skill selection.
Other prompts and every bus call wait or fail. After preparation ends, the adapter
records the actual workspace and confirms Stop, clears the preparation model context,
finalizes the canonical binding,
then sends the first assignment with its complete role context. Clear context
starts a fresh native Codex thread: resuming the preparation thread would retain
its empty dynamic tool catalog even after Stop; BB event history remains retained. Failed preparation
remains orphaned for operator recovery; it never grants bus rights.

`participant get --task <id> --participant <id>` awaits SDK observations before
returning a plain `SessionView` and the original BB status. Active/starting is busy;
idle is reachable and resumable. Stopping, pending, error and unavailable/offline
observations remain unknown. `alive` is logical thread availability, not proof of
a native process. `participant stop` succeeds only after a fresh idle observation,
with no background agents and an available host/environment. Stop releases the
runtime and leaves the environment in place. A reviewer private home remains for
resume and evidence.

`participant archive` first holds further adapter dispatches, confirms Stop and
saves a complete SDK patch snapshot relative to the recorded base SHA as an engine
artifact in the stable coordinator. The manifest includes actual HEAD, branch,
environment and thread refs. Canonical messages and result artifacts are already
outside worker environments. The coordinator's `.promptobus` journal is retained
directly and excluded from its own source snapshot. Truncated/missing patches,
binary marker-only output, submodule changes, unstable snapshots, diverged base SHA,
missing base SHA
or an unconfirmed Stop block archive and retain the environment. Legacy bindings
without a recorded base SHA therefore need operator preservation rather than
automatic archive.

Archive follows preservation and a final stopped/unchanged check. Lifecycle children,
including children outside plugin storage, must be archived first. Failed preservation
remains `archiving` across reload and can be retried. Archived bindings keep their
immutable thread refs and snapshot digest; archive never accepts or closes the task.
BB owns retirement after the last unarchived thread leaves a managed environment;
its default grace is five minutes. Reused environments retain their BB provider's
retention policy. Native `done`, `sweep` and journal pruning leave BB resources alone.

Direct BB operator actions, including Send now, archive/delete and environment
cleanup and concurrent dependent creation by other SDK clients, can bypass the adapter's admission/preservation path. Preserve results
through this CLI before those actions. This adapter cannot veto an explicit BB
operator override or protect concurrent external filesystem edits after its check.
Preexisting work in a reused environment remains its original owner's responsibility.

Models are read from the actual Codex app-server catalog. Usage windows and full
role workflow support are not claimed by this reviewer provider.
