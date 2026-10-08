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
four explicitly classified authenticated bus tools below for bound reviewers and
the exact `promptobus_host_context` / `promptobus_host_call` Host bridge names.
Unclassified external tools are omitted, and forged tool calls are denied before
forwarding. Canonical reads pass through the authenticated host entry with fresh
Host classification; native MCP stays disabled. Prompt text is not the enforcement boundary.

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
  --provider codex --reasoning-level medium \
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

The plugin records the launch attempt, assignment and model before calling SDK
spawn. `bb promptobus recovery inspect --task <id> --participant <id>` returns
the recorded phase, thread id and launch summary. When the spawn reply was lost,
it lists candidate threads carrying the attempt marker. This writable metadata
is diagnostic only: inspection never binds a candidate, grants tools or retries
spawn. Preserve any candidate work before explicitly stopping or archiving it
through BB. An ambiguous launch requires operator intervention; creating another
thread does not repair the old participant.

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
| `promptobus_host_context` | `mode: inspect`, or `read` with `path`, optional `start_line`, `line_count` | Fresh Host rules/skills/catalog or bounded reads of declared rule/skill resources |
| `promptobus_host_call` | `server`, `tool`, `args` | Freshly admitted canonical call through the consumer adapter; role/root/actor come from the binding |

All argument objects are strict. Sender, task and address are derived from the
binding, and cannot be supplied. Body size is capped at 2400 characters; attachment
text at 1 million characters and artifact reads at 1 MB. Reporter bindings omit
send. Routing currently goes through the task orchestrator; worker lateral sends
are refused. New role threads use built-in Codex except reviewers, which use the
constrained provider. Bus writes do not grant reviewer source or shell writes.

The six role skills, model-catalog selection and recipient wake/recovery are delivered.
The measured six-role workflow and its profile limits are recorded below.
BB queued first prompts are admission state, not the canonical Promptobus mailbox.

## Provider and model selection

`task create` and `participant add` require `--model`. Optional `--provider`
must match the role: `codex` for the owner, worker, approver, teamlead and reporter;
`promptobus-codex-reviewer` for reviewer. There is no fallback between providers.
Optional `--reasoning-level` must be supported by that model; omission selects the
SDK catalog's default, which can differ from the native Promptobus defaults.
The SDK model id sent to spawn and the native model name are recorded separately.

For example, inspect a reviewer selection without creating a task or thread:

```sh
bb promptobus routing inspect --environment env_example --role reviewer \
  --provider promptobus-codex-reviewer --model gpt-6.1-sol --reasoning-level medium
```

Selection checks the actual connected host, existing environment, provider,
model inventory and reported provider health before canonical reservation or
SDK spawn. A new managed environment uses its host's model catalog and health,
and requires a host-scoped catalog. Unknown or failed model availability refuses;
unknown health remains explicit when a valid model catalog is available.
Unavailable installation/authentication reported by health refuses.

Quota is an observation of the selected provider's account windows on its host.
Missing or failed usage, empty windows and providers without a usage API report
`unknown` with no invented percentage. Reviewer usage is not exposed by this
provider and never borrows regular Codex windows, even if both use one account.
The selection contains no account email or inferred per-task cost. Account windows
are evidence, not an automatic fallback or a new quota threshold policy.

Participant bindings and launch replies expose `execution`: runtime, native
harness, provider/model/reasoning, selection source, scope and observation time.
The canonical participant also stores it in `metadata.bb.execution`; its top-level
`harness: bb` remains the adapter/lifecycle discriminator. It is the launch decision snapshot. `participant get` additionally reads SDK
`currentExecution`, which may be null or differ after an operator changes a
normal Codex thread's settings. The constrained reviewer requires a fresh session
for model/effort changes. `recovery inspect` reports the persisted launch
`reasoningLevel`; a legacy intent without it reports `null`.

This BB facade does not apply native `--strategy`, `--harness` or `--effort`
flags or native routing overlays; its CLI rejects them. Use the native Promptobus
CLI when those constraints are required. The native catalog, strategy resolution,
account caches and defaults are unchanged.

| Provider | Supported roles | Usage |
| --- | --- | --- |
| `codex` | orchestrator, worker, approver, teamlead, reporter | SDK host/provider account windows, or unknown |
| `promptobus-codex-reviewer` | reviewer | Unknown; no usage API |

The supported versions are BB 0.45.0, SDK 0.6.15 and the reviewer's verified
Codex CLI 0.162.0-alpha.2. Other BB providers are not admitted.

## Wake and recovery

Canonical send commits mail and artifacts on the host before requesting a BB
wake. A listener-backed service scans recorded ready participants every second;
it replays stored BB events in sequence and reads canonical unread IDs. SQLite
stores the event cursor, mailbox revision, outgoing hint, attempts and pause epoch.
Listeners are registered before this recovery scan. A crash between canonical send
and saving an outbox entry is recovered from the unread mailbox. Reconnect and
duplicate announcements cannot create another thread or ACK mail.

Hints name the task, participant, revision and canonical IDs. The agent consumes
mail through `promptobus_mailbox` with `mode: read`; repeated hints do not replace
this ACK or request repeated acknowledged work. SDK `sent`, `queued` and waiting
interactions are delivery observations. None proves mailbox consumption, completed
work or acceptance. The SDK exposes no public spawn/send idempotency key; delivery
and source-work effects are not exactly-once transactions across the two stores.

The adapter sends only to an available idle thread without background agents,
pending interactions or other queued input. It uses `queue-if-active` to handle a
concurrent start. A queued hint is reconciled by its marker; a lost accepted reply
is reconciled against event history. Without a queue or request record it waits
30 seconds before a bounded repeated hint. There are at most three hints per
unread revision. A canonical `task` acknowledged by a non-owner, non-reporter role
without a later canonical `result` or `review` gets at most two turn-boundary
continuations. This does not certify which assignment a result fulfilled; the role
workflow owns that decision. Exhaustion requires explicit operator recovery.

`bb promptobus recovery run` performs the same scan once. `recovery inspect`
reports intent, cursor, outbox and pause state. SDK/host unavailability remains
unknown and is retried by reconciliation; `error`, `stopping`, rejected turns,
interrupted turns and denied/cancelled approval interactions pause continuation.
Pending interactions are left for the user. Repair the failure or resolve the
interaction before explicitly resuming; recovery never retries failed source work.

Pause controls automatic Promptobus wake and continuation. Explicit operator messages, including BB queued inputs, remain BB actions and may run while paused; they neither resume automatic delivery nor ACK canonical mail.

For a durable stop, use `bb promptobus participant stop --task <id> --participant
<id>`. It records pause before waiting for SDK Stop and cancels its own queued
hint. Late replies cannot clear the pause, and stale hints are refused at dispatch.
Dispatch rechecks the pause after async validation. Stop during launch cancels the
automatic initial assignment and leaves the recorded thread orphaned for operator
inspection; its launch intent and environment remain preserved.
The initial assignment carries its durable launch marker, independent of SDK send
attribution. Recovery and dispatch replay interruption history after async checks;
an overlapping announcement cannot admit a wake using an earlier idle observation.
Launch history is replayed before arming delivery, including preparation interruption.
The adapter's preparation Stop runs only after a confirmed available idle turn;
it cannot erase a user's earlier active Stop.
`participant resume` requires fresh identity/canonical validation and an available
idle thread without pending interactions, then explicitly resets the bounded
delivery budget. Existing bindings created before this delivery state remain paused
until this command; a reload cannot assume they were running.

An active BB `Stop` is also observed through the interruption history and remains
paused after reload. **An ordinary BB `Stop` on an already-idle thread is not a
durable pause through SDK0.6.15:** on the measured BB0.45.0 test, it changed neither
the public thread state nor its event log. Use the plugin stop command for this
case. Direct BB Send now can bypass the dispatch hook by design; an explicit BB
send can run a turn, but automatic continuation remains paused until plugin resume.
Archive/deletion and participant binding phases also prevent automatic revival.

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
with no background agents and an available host/environment. Plugin Stop records
the durable delivery pause described above and releases the
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

## Consumer Host setup

The default host entry uses `createStandaloneHost` for each actual environment.
A consumer workspace provides a source module exporting the options for
`createBbHostIntegration` from `promptobus/bb-host`. Its Host owns repo/module/base
rule discovery, canonical skills, reviewer classification and server declarations.
Its `listTools` / `invokeTool` callbacks own canonical transport and argument
validation. Server configuration and credentials stay host-side. Reporter and
reviewer roles both require complete write classification.

Generate a new plugin directory from this canonical source package:

```sh
node scripts/create-host-plugin.mjs --directory /absolute/new-plugin \
  --integration /absolute/consumer/host-integration.mjs \
  --promptobus 'file:/absolute/promptobus-package.tgz'
cd /absolute/new-plugin
npm install
npm run check
npm run skills:check
bb plugin build
bb plugin install .
bb plugin reload promptobus
```

Use a packed release or another explicit supported package spec. The integration
module keeps its own dependencies installed in its consumer project. Generation
copies canonical TypeScript, role skills and setup scripts; it does not copy
ignored build output, adapters, tests or dependencies. It refuses existing output
directories. The entry imports the consumer source module, which BB bundles on
build. Keep secrets in host-side runtime configuration, not source literals.
This variant has the same plugin id `promptobus` and replaces the default variant;
it is not a second parallel plugin.

An optional `prepareEnvironment` callback runs the consumer's generator for the
actual environment before collection. Existing and newly provisioned environments
receive full rules and canonical skill text in their assignment, beyond BB's
4096-character dynamic instructions limit. `promptobus_host_context` can read
additional declared skill resources; it grants no arbitrary workspace read.
`promptobus_host_call` derives role/root/actor from the binding and freshly checks
admission before callback dispatch. Tools appear only when the collected context
requires them. A running Codex session keeps its native tool inventory: after a
source/context change regenerate/build/reload and create fresh participants.
Never hand-edit generated adapters or assume reload changes an existing session.

## Approver admission and workflow support

Add an approver with explicit predecessor ids:

```sh
bb promptobus participant add --task demo-t20261008-120000 \
  --participant acceptance-api --role approver --worker worker-api \
  --reviewer review-api --new-environment --base-branch main \
  --model gpt-6.1-sol --assignment "Judge the recorded review and actual gates."
```

The reviewer must use the worker's actual environment (`--environment <worker-env>`).
Approver can use its own managed environment. SDK/source ownership remains BB's.
Both predecessors must be canonical BB participants of the selected task and
subject. The existing pipeline gate requires their `type: result` after each
current assignment; `type: review` alone is not that result. Selection checks
before reservation/spawn, after preparation, at dispatch and before approver tools.
A new canonical `task` assignment makes the old result stale. Legacy participants
without an initial assignment timestamp require fresh participants. A pipeline
without the shipped approver step refuses; custom BB step names are unsupported.

Results and artifacts are facts. The gate does not inspect verdict truth, execute
reported tests, verify a claimed commit or accept a task. Worker/reviewer/approver
judgment and the operator's final source verification remain required. Approver
archive is preservation, not acceptance; task journals remain unaccepted until an
explicit operator acceptance action.

The 2026-10-08 live workflow established the following source profile. It used
actual canonical messages, committed source and retained artifacts; SDK fixtures
alone are not this support claim.

| Profile | Status | Boundary |
| --- | --- | --- |
| One primary local host; BB 0.45.0, SDK 0.6.15, Codex CLI 0.162.0-alpha.2; macOS 27.0, Node 25.2.1; `gpt-6.1-sol`, `low` | Full six-role runtime observed | Built-in Codex for orchestrator, worker, approver, teamlead and reporter; constrained Codex provider for reviewer; shipped worker/reviewer/approver pipeline |
| Mixed native reviewer and BB workers | Partial | Does not establish the full BB profile |
| Other providers, versions, hosts, models/efforts or custom pipeline shapes | Unverified or unsupported | No full support claim; provider substitution and remote environments refuse |
| Package delivery | Source-only, unreleased | Build this checkout and a matching packed library; older releases lack this adapter |

The representative fixture retained current worker and reviewer results for the
same actual managed environment. Approver admission refused before those results.
Worker made one commit; worker and approver independently executed four assertions
on that HEAD, and approver fast-forwarded only the disposable local main. Teamlead
supplied a plan; reporter read the retained facts. Reviewer execution and reporter
canonical writes were mechanically denied before callback dispatch. Their source
and verdict evidence remains distinct from tests the operator ran.

Replacement preserved the first worker before archive. Durable Stop retained an
unread assignment across plugin reload; explicit resume executed the work once.
A manually queued BB input ran as an explicit operator turn while automatic
delivery stayed paused. Queue persistence is not promised by this adapter.
All seven bound test participants and the bootstrap thread were archived; child
snapshots preceded owner archive. The canonical test journal remains active and
unaccepted: lifecycle preservation does not accept source or reported facts.

These fixture artifacts demonstrate runtime behavior, not a consumer release
certificate or standardized gate/handover schema validation. Consumers retain
those records and judge their own source, review and real gates. SDK limits remain:
already-idle BB Stop is unobservable and the constrained provider has no usage
API. Native dynamic tool notifications now produce correlated BB timeline rows
with arguments, completion and results; stale or stopped turns cannot add rows. No remote push or release publication was part of the proof.


Dispatch validation shares one 5000 ms abort budget across SDK identity reads,
Host calls and event replay, below BB's 10-second hook cap. Temporary validation
loss returns `wait` with a scheduled recheck; identity mismatch refuses. Every
model tool still performs independent authorization.

Cancelled wake receipts remain in plugin SQLite for the binding's lifetime.
Recovery retries deletion of exact Promptobus-owned queued text after late send
responses, failures and reload, including while automatic delivery is paused.
Generated wake text carries SDK `visibility: agent-only` metadata for durable
request correlation; ordinary copied or quoted text does not. This presentation
metadata is not authorization. BB `threads.send` may omit plugin origin; dispatch
and queue cleanup then correlate the complete stored generated payload and its
metadata, while excluding explicit foreign plugin origins. Every model tool
checks its binding independently. Copied or quoted user
inputs remain user-owned. Rejection of an obsolete owned
hint does not pause a freshly resumed generation; operator Stop still does.

Host context collection refuses symlink entries in `skillsDir()` explicitly.
BB approver admission requires the shipped worker/reviewer/approver names and
kinds in that order; a missing, renamed or differently typed step refuses before
launch. Native configurable pipeline behavior is unchanged.
