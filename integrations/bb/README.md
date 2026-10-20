# Promptobus for BB

This optional package owns the local BB adapter: engine-backed native tools,
authoritative participant bindings and a constrained Codex reviewer provider.
The native Promptobus CLI and harness registry keep their existing entry points.

## Setup

Use BB 0.45.0 or 0.46.0 and Plugin SDK 0.6.15 on one local host. Install Codex CLI
and sign in with `codex`. The provider verifies the required runtime restrictions,
without an exact or maximum numeric Codex version requirement.
The provider copies only `auth.json` into its private Codex
home; it does not modify the original authentication or copy personal config.

From this local source directory, run `npm ci` and `npm run build`, then install
the exact generation named by the build receipt's `installationDirectory`:
`bb plugin install ./.runtime/<buildId>`. The source root is a build descriptor,
not a supported install target.
Select `Codex (Promptobus read-only reviewer)` and an explicit reported model.
The BB permission mode is `accept-edits`; the provider always requests and verifies
Codex `readOnly` with approval policy `never`, regardless of that BB label.

## Executing runtime identity

Inspect the executing plugin server and selected host without a task binding:

```sh
bb promptobus runtime describe
bb promptobus runtime describe --host host_example --json
```

JSON is the default. Selection uses `--host`, then the invoking thread's
environment host, then the primary host when there is no invoking thread.
`complete` and exit 0 require matching non-null `buildId` and `inputSha256`;
unbuilt, mismatched, older incompatible or unavailable entries return
`incomplete` and exit 1. One read-only host RPC has a 5000 ms timeout;
cancellation propagates. Inspection performs no retry, reload, spawn, model call,
engine operation or task-state write.

`npm run build` captures source, skills and resolved dependencies in a new
`.runtime/<buildId>` package, stamps only that copy and runs the official BB build.
Install the exact generation recorded by the successful receipt to activate it.
Building B preserves loaded A; reloading registered A stays on A. Only explicitly
installing B switches it. Builds perform no install, reload or old-generation
deletion. The id names captured inputs, not BB loader cache bytes or external
SDK/Node APIs. Local path delivery is supported; npm/Git automatic plugin
installation is not claimed. Local fixtures do not certify a particular BB
installation; verify the executing identities after install/reload.
See the [Host reference](../../docs/reference/02-host.md#bb-executing-runtime-identity)
for snapshot boundaries, fields and failure reasons, and the standalone
`promptobus-runtime` skill for diagnosis. The six generated role skills are unchanged.

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
model mismatch refuses startup before the first model turn. Missing or widened
runtime restrictions refuse startup regardless of the reported Codex version.
See the [compatibility proof](../../docs/reference/02-host.md#bb-reviewer-compatibility-proof)
for the measured versions, native denials and reproducible test. The test matches
the entire reviewed exec source, call/output identity and turn, and independent
router stderr from the isolated child. The nested patch has no separate native
target event; its target is attributed through that exact exec source. Historical
record replay and new runtime measurement are reported separately.
Startup also verifies the effective disabled features, private home and absence
of configured MCP servers, including managed configuration. Model and effort
changes require a fresh reviewer session.


## Display names and acceptance placement

Titles begin with the card/task label, role and short subject. `task create` and
`participant add` accept `--display-label`, `--display-subject` and
`--repository-label`, including explicit related pairs. Defaults use the canonical
task id, participant id and verified coordinator workspace basename. A reviewer
sharing exactly one worker's actual environment inherits its display metadata.
Only newly launch-owned, unnamed environments without other users are named;
custom and shared names remain intact. Launch output reports the naming outcome;
metadata failures retain an orphan binding instead of claiming success.

A new approver is spawned below its authenticated worker, retaining its selected
acceptance workspace and the orchestrator lifecycle owner. Raw metadata reparenting
of an already bound thread is refused by authentication. The
[display contract](../../docs/reference/02-host.md#bb-display-names-and-acceptance-placement)
describes defaults, inheritance, ownership checks and the SDK fixture evidence
boundary. Live sidebar and new-source native behavior remain unmeasured.

## Role instructions

Workers send milestone status: their first message, a change of plan or blocker,
and a long background run with volume and a measured estimate. Status remains in
the orchestrator mailbox without its own bus wake; the next actionable message
carries it. Decisions require questions. BB system child outcomes still follow
the host lifecycle; their safe suppression needs the public capability described
in the [host boundary](../../docs/reference/02-host.md#local-bb-host-boundary).

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

## Provider session preparation

Reused Cursor and OpenCode environments use the same preparation sequence as
new worktrees and existing-path registration: a bounded turn without assignment
or plugin tools, confirmed Stop, cleared preparation context, canonical binding,
then the assignment. The reused environment id must remain unchanged. This uses
the owning participant, without an extra helper thread, and retains `accept-edits`.

BB tool-set changes apply on the next provider session start. An early session
configuration during spawn can precede the recorded thread id and ready binding;
holding message dispatch alone does not refresh that session's tool catalog.
Stop releases the loaded runtime and Clear context discards the preparation
session before assignment. Configuration remains ready-only and each tool call
rechecks authenticated identity. These ordering fixtures do not prove live bridge recovery;
a provisioned session that still lacks the bridge needs separate runtime evidence.

Every bound participant dispatch rechecks current launch control before a model
turn, including user input and anonymous assignment delivery. Pausing automatic
delivery does not revoke a valid grant. User input cannot reactivate an ended or
stopped grant; use the operator resume and fresh-phase protocol.

## MCP schema and permission boundary

Every selected tool exports an MCP input schema with root `type: "object"`.
`promptobus_host_context` retains its strict inspect/read union and validation;
its root object metadata supplies the type required by MCP clients.

A measured OpenCode session completed authenticated task, mailbox and send calls.
A measured Cursor session exposed the MCP server, but an agent-initiated turn
received `User rejected` without a user interaction. BB sets
`permissionEscalation: "deny"` for non-user turns and rejects approval requests
before publishing an interaction. A genuine user turn uses `"ask"`; selecting
**Allow once** for each exact bound-tool request is a prospective remedy whose
live result remains unverified. Keep the provider permission mode and tool
selection unchanged. These measurements do not certify other sessions or models.

## Local task entry point

Build the root library before `npm ci` in this package so the local `file:../..`
dependency contains its current public exports. After source changes, run
`npm run build` and explicitly install the new receipt's generation directory.
Reload alone keeps the generation already registered with BB.
`bb promptobus --help` describes the operator CLI.

From the repository root, install and build the source package:

```sh
npm ci
npm --prefix integrations/bb ci
npm --prefix integrations/bb run build
```

```sh
bb promptobus task create --task demo-t20261008-120000 --title "Demo" \
  --project proj_example --environment env_example --model gpt-6.1-sol \
  --provider codex --reasoning-level medium \
  --launch-context "$OWNER_LAUNCH_CONTEXT" \
  --assignment "Read the task and wait for mail."
bb promptobus participant add --task demo-t20261008-120000 \
  --participant worker-api --role worker --model gpt-6.1-sol \
  --launch-context "$WORKER_LAUNCH_CONTEXT" \
  --assignment "Implement the supplied assignment."
bb promptobus bindings
```

Use real existing project/environment ids on the primary local host and a Git
coordinator environment with an actual HEAD. The coordinator must be unmanaged:
its canonical journal must outlive BB worker environment retirement.

Prepare each role's complete bounded JSON input described under
[required inputs](#required-launch-and-review-inputs); the example variables are
placeholders for those exact authorized contexts. The first
command creates the canonical task and a new owner thread; the second adds a
new participant to that plugin-owned active task. Both hold the first prompt
until the returned BB thread identity is finalized. A launch failure remains
`orphan` in `bindings`; it is never silently reassigned. This CLI is a trusted
local machine-operator entry point. It does not expose a bind-existing-thread tool.

`bb promptobus bindings [--task <id>] [--participant <id>] [--limit <1..100>]
[--cursor <number>]` returns `{ "items": [...], "nextCursor": number | null }`.
Each item contains only `task`, `participant`, `threadId`, `role`, `phase`,
`projectId`, `environmentId`, `hostId` and `providerId`; orphan rows remain visible,
including a null thread id. Tokens, contexts, grants, history, evidence, assignments
and bootstrap text are excluded. Filters match exact ids; a participant filter
can span tasks unless `--task` is also supplied.

The default page size is 50, the hard maximum is 100, and complete successful JSON
is at most 64 KiB in UTF-8, including metadata and the continuation cursor. Rows
are selected as summaries directly from SQLite in numeric row order, without
loading full binding payloads into the inventory. Supply the returned `nextCursor`
as `--cursor` with unchanged filters to continue; null means no matching rows
remain. Traversal covers unchanged data without duplicates or omissions; it is
not a snapshot across concurrent changes. A byte-limited page can contain fewer
rows than `--limit`. A single summary that cannot fit causes exit 1 with an
actionable bounded error identifying its row; it is never skipped. Invalid limits
or cursors also refuse with bounded output. This inventory reports stored identity
and phase, not fresh runtime state, current grant authority or admission evidence.

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
are refused. New role threads use their selected provider under the role policy
below; reviewers use the constrained Codex provider. Bus writes do not grant
reviewer source or shell writes.

Reviewers send every body within the 2400-character cap. A long review uses
consecutive `status` bodies starting with `Review <grant-token> part i/N` and a
newline, followed by the exact payload. One terminal `result` retains the four-line
hand-off header, severity totals, `Review <grant-token> complete N/N` and the sole
all-calls release. A report wholly in the result uses `complete 0/0`. The
orchestrator reads full canonical bodies, including acknowledged status parts,
checks sender, grant token, totals, order and release, and rejects incomplete,
duplicated or reordered reports before relying on them. This is a procedural
check; the bus does not assemble or validate parts. Reviewers need no artifact,
shell or filesystem write. See [bounded reviewer reports](../../docs/reference/04-protocol.md#bb-bounded-reviewer-reports).

The six role skills, model-catalog selection and recipient wake/recovery are delivered.
The measured six-role workflow and its profile limits are recorded below.
BB queued first prompts are admission state, not the canonical Promptobus mailbox.

## Provider and model selection

`task create` and `participant add` require `--model`. The default provider is
`codex` for the owner, worker, approver, teamlead and reporter, and
`promptobus-codex-reviewer` for reviewer. Workers also admit explicit
`--provider acp-cursor` or `--provider acp-opencode`; approvers also admit
`--provider acp-cursor`. Other role/provider pairs refuse. There is no fallback
between providers. Every selected provider must support `accept-edits`.
Optional `--reasoning-level` must be supported by that model; omission selects the
SDK catalog's default, which can differ from the native Promptobus defaults.
The SDK model id sent to spawn and the native model name are recorded separately.
Use the selected provider's SDK catalog spelling: Cursor's BB model and
reasoning level are separate fields, unlike the native Cursor CLI suffix.
An unlisted or selected-only model remains refused.

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

Stored participant bindings and launch replies retain `execution`: runtime, native
harness, provider/model/reasoning, selection source, scope and observation time.
The `bindings` inventory omits this launch snapshot.
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
| `acp-cursor` | worker, approver | SDK host/provider account windows, or unknown |
| `acp-opencode` | worker | SDK host/provider account windows, or unknown |

The host range is BB `>=0.45.0 <0.47.0` with SDK 0.6.15. The historical native
permission proof measured Codex CLI 0.162.0-alpha.17.2. BB 0.46.0
loads; its full workflow is not a separate measurement. Cursor/OpenCode selection,
worker provisioning, authenticated tools and recovery, and Cursor acceptance
predecessors have SDK fixture coverage. This is separate from a measured live
model workflow. Other BB providers are not admitted.

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
the pinned optional testing peers in devDependencies, including Hono `4.13.13`.
The SDK optional Hono peer also appears in this checkout's production dependency
graph; `npm audit --json` checks its resolved version. Build with `npm run build`
to verify the self-contained host bundle as well as the server. Mock SDK evidence
and actual local tool-turn evidence are reported separately.

The packed Host setup fixture installs into a fresh temporary directory and
checks that npm resolves its cache inside that directory. Both the installation
and its cache are removed by the fixture's cleanup.

## Lifecycle

`participant add --environment <id>` reuses an existing local environment.
`participant add --environment-path <absolute-path>` registers an existing local
Git worktree in the coordinator's project through SDK unmanaged-path spawn.
It cannot be combined with `--environment`, `--new-environment` or `--base-branch`.
Use the exact normalized absolute path BB will report; a different returned path
refuses binding rather than selecting another workspace.
`participant add --new-environment --base-branch <branch>` asks BB to create a
managed worktree. The SDK owns creation; no native Promptobus worktree name or
`git worktree add/remove` is reconstructed. Children explicitly name the owner
thread as both `parentThreadId` and `lifecycleOwnerThreadId`. Returned actual
environment id, path, branch, host and HEAD SHA are retained in plugin storage and
canonical participant metadata.

BB 0.45.0 provisions an unmanaged path or new managed worktree after the first
prompt, not when it creates the thread row. Deferred spawn also defers provisioning;
a null environment id is not a successful launch. Both routes use the participant's
own bounded bootstrap, without an extra helper thread. A bound `provisioning` phase admits only the exact nonce-bearing
preparation prompt, with no assignment, plugin tools or role skill selection.
Other prompts and every bus call wait or fail. After preparation ends, the adapter
records the actual workspace and confirms Stop, clears the preparation model context,
finalizes the canonical binding,
then sends the first assignment with its complete role context. Clear context
starts a fresh native Codex thread: resuming the preparation thread would retain
its empty dynamic tool catalog even after Stop; BB event history remains retained. Failed preparation
remains orphaned for operator recovery; it never grants bus rights.
Before canonical reservation and assignment, the adapter verifies the returned
thread's project, provider, parent and lifecycle owner, an idle unarchived thread
without background work, and the ready environment's id, project, local host, path,
mode and actual Git HEAD. Preparation waits at most 120 seconds. Missing paths,
non-Git workspaces, unavailable HEADs and mismatched or ambiguous replies refuse
assignment. `recovery inspect` retains the requested path and launch attempt;
it never retries spawn or treats a candidate as an authenticated participant.
Existing paths retain `environmentOwner: existing`; BB never acquires workspace
deletion ownership through this option. SDK fixtures cover these cases; live
existing-path registration has not been measured on this source change.

`participant get --task <id> --participant <id>` awaits SDK observations before
returning a plain `SessionView` and the original BB status. Active/starting is busy;
idle is reachable and resumable. Stopping, pending, error and unavailable/offline
observations remain unknown. `alive` is logical thread availability, not proof of
a native process. `participant stop` confirms only after awaiting SDK Stop and a
fresh observation with both display and raw status idle, `activeBackgroundAgentCount`
and `queuedMessageCount` exactly zero, and an available host/environment. Missing
or nonzero queue evidence refuses confirmation. Plugin Stop records the durable
delivery pause described above and leaves the environment in place. A reviewer
private home remains for resume and evidence. Public Stop `ok` and these logical
observations do not prove daemon acknowledgement or complete task-owned call
terminality after an unavailable host or timeout. Error-state recovery remains
unconfirmed without that proof.

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
npm run build
bb plugin install ./.runtime/<buildId>
```

Use a packed release or another explicit supported package spec. The integration
module keeps its own dependencies installed in its consumer project. Generation
copies canonical TypeScript, shipped skills and setup scripts; it does not copy
developer `.runtime`/`dist`, adapters, tests or dependencies. It refuses existing
output directories. The generator selects `host.mjs` and the core dependency
before installation. After `npm install`, `npm run build` captures the selected
consumer's static integration graph with the public BB host builder and stamps
this consumer's own generation. Use the successful receipt's exact `buildId` in
the install command. Keep secrets in host-side runtime configuration,
not source literals. The plugin itself is installed from its local generation path;
the explicit package spec above selects the core dependency, not a plugin
distribution route.
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
source/context change regenerate the consumer if needed, run `npm run build`,
explicitly install the new generation and create fresh participants.
Never hand-edit generated adapters or assume reload changes an existing session.

## Approver admission and workflow support

Add an approver with explicit predecessor ids:

```sh
bb promptobus participant add --task demo-t20261008-120000 \
  --participant acceptance-api --role approver --worker worker-api \
  --reviewer review-api --new-environment --base-branch main \
  --launch-context "$APPROVER_LAUNCH_CONTEXT" \
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

Evidence inventories preserve exact test names, order and repeated occurrences
from complete raw output. Remove only a supported verdict's terminal numeric
duration; retain parentheses, punctuation, Unicode and internal spacing. Keep
lint and other gate status separate, and check names, counts and multiplicities
against the raw test scope. Raw output is authoritative; approximate inventories,
missing raw and unsupported formats are explicitly incomplete.

The checkout-only [reference helper](../../scripts/bb-evidence-verdict-names.mjs)
supports one flat passing Node spec scope with one complete footer. Nested or
concatenated scopes, custom printers, other reporters, ANSI output, failures and
skips are unsupported. The helper cannot certify gates; the extractor is shipped in the
library package. Manual lossless opaque UTF-8 evidence with retained raw output
remains valid. See [BB evidence attachments](../../docs/reference/04-protocol.md#bb-evidence-attachments).

### Required launch and review inputs

New `task create` and `participant add` calls take `--launch-context <JSON>`.
Missing role/root/control/grant fields refuse before substantive assignment.
The context is bounded to 256 KiB and uses the exact complete literal returned by
`renderBbInstructionSkill(role)` from `promptobus/instructions`, even when the
consumer Host catalog is empty. This startup checks configuration; the ordinary
participant still authenticates the actual BB task/mailbox in its first turn.
No additional diagnostic model or similarly named native MCP tool is substituted.

| Field | Required content |
| --- | --- |
| `ownedRoots`, `readRoots` | Exact absolute owned paths and provider-permitted reads, declared by the owner; no permission widening |
| `role` | `name: BB_ROLE_SKILLS[role]` and the complete `literal` |
| `grant` | Exact `actor`, `task`, immutable `token`, active `state`, fresh `phase`, scope `repository`, `branch`, full `base`, `operations`, and `preconditions` |
| `control` | `mode: file` with a bounded readable `path`, or `mode: inline` with the complete current snapshot and `signals: ["Hold", "Stop"]` |
| Inline snapshot | `ownerConfirmed: true`, `STOP: false`, `noNewStages: false`, exact active `grant`, and all `endedTokens` |
| `preparation` | Exact argv `commands`, `status: complete` or `notRun` with `reason` |
| `quota` | Named `authority`, `missingUsage: informational`, `soft`, `hard`, `maxActiveIncludingOwner`, `PAYG: false` |
| Reviewer `review` | Original `producer`, explicit `producerBinding`, `sourceEnvironmentId`, full `base`, exact argv `requiredGates`, explicit `requirePassingGates` |

For provisioning, declare the expected target path/branch/base; the actual SDK
identity must match after preparation. The preparatory READY turn executes no
assignment. A constrained reader whose external control file is outside its
read roots receives inline control and Root signals. Ended tokens never resume;
repairs require a fresh complete bounded phase. Persisted older bindings remain
explicitly `notMeasured`, without a fabricated startup measurement.

For the same existing actor, `participant resume --launch-context <JSON>
--assignment <complete-phase-text> --evidence-manifest <JSON>` installs a fresh
review phase. It requires a different grant token and phase, and current control
must name the previous token as ended. The complete original manifest is checked
before Stop/context reset and again before delivery. The same BB thread, binding,
parent and lifecycle owner remain; the new initial assignment contains the full
context and all original IDs. Mailbox wakes stay fenced while that assignment is
pending, including a queued or unknown send. Queue cancellation preserves the
complete text and delivery identity; explicit resume retries that same context
after fresh control/evidence checks. A matching `client/turn/requested` receipt
releases a queued fence. A newer Stop during context reset, evidence transfer or
delivery wins over the epoch captured at transfer start. No automatic
evidence-only turn substitutes for the initial assignment. A canonical phase task
still comes from the coordinator; this command does not invent a task sender.

Every source-and-evidence reviewer also takes `--evidence-manifest <JSON>`.
`producerBinding: participant` requires a ready canonical participant.
`producerBinding: owner-declaration` requires `ownerDeclaration`, the actual ID
of a canonical owner-sent `.txt` artifact authorizing the exact typed manifest
hash, task, reviewer, grant token, producer and source environment. A worker relay
cannot supply that authorization. It does not authenticate the external runner:
canonical owner, attachment sender, original producer and command proof stay separate.
Every selected reviewer read environment must be clean, bounded and at the
declared source HEAD before spawn/resume; provisioned snapshots are rechecked.
The recorder and manifest share a direct-command guard, including shell runners
behind one supported `env` launcher with literal assignments. Other `env` options
and nested launchers are unsupported.
Plain resume preserves the epoch captured before binding/control awaits.
Anonymous early cancellation is correlated with the actual late queue reply,
keeping the complete context available for explicit retry. Bound reviewer file
reads recheck the current owner grant; stopped or ended file-control grants deny
reads before filesystem access. The shared command guard rejects the POSIX
`dash`, `ash`, `ksh`, `ksh93`, `csh` and `tcsh` executable forms as well.
The public typed contracts are in `launch-context.ts` and `review-evidence.ts`.
The manifest holds source/base, original producer and relayer, clean state,
original direct receipts, gate/handover/inventory IDs, ordered full raw parts with
UTF-8 bytes/hashes and all five check details or concrete `notRun` reasons.
Only actual artifacts are admitted; normal message IDs, wrong tree/producer,
cropped raw, broken hashes and pipeline-masked receipts refuse before spawn.
All original IDs enter the immutable first assignment and remain readable through
the actual bound `promptobus_artifact`. Late steering is supplementary.

The coordinator can land a complete owned file without copying megabytes through
a model: `bb promptobus evidence upload --task ID --file /absolute/owned/file --to RECIPIENT`.
It returns original opaque UTF-8 part IDs and landed filenames, with byte counts
and hashes, using the current bound actor. Each part is at most 900000 bytes; the
file is at most 64 MiB. Original producer identity stays in the receipt/handover
when the coordinator relays another actor's output. A checkout can record a
direct command with `node scripts/bb-record-command.mjs --output /absolute/owned/stem --by ACTOR -- npm test`.
Its complete stdout/stderr and `bb-direct-command-v1` receipt retain the runner's
own return code. It reserves all three files before spawning; a refusal reports
`notRun: true`, and a sink failure stops and reaps the runner with incomplete
evidence. Attachment sender lookup includes `task` and `result` messages before
and after acknowledgement or reload. This recorder is not an authorization or actor-authentication
tool. Shell pipeline executables are unsupported.

The mechanical validator supports complete flat passing Node spec inventories;
custom, nested and concatenated scopes retain authoritative raw with explicit
`notMeasured`, and cannot claim certified counts or a complete name difference.
Their inventory's optional `raw` scope retains distinct original base output;
ordered parts and bytes/hashes are validated even without name certification.
Opaque handover details and upload acceptance do not certify truth or native
schemas. The admission, original-part transport and retained failure replay have
SDK fixture coverage; the changed live provider workflow is `notMeasured`.

The 2026-10-08 live workflow established the following source profile. It used
actual canonical messages, committed source and retained artifacts; SDK fixtures
alone are not this support claim.

| Profile | Status | Boundary |
| --- | --- | --- |
| One primary local host; BB 0.45.0, SDK 0.6.15, Codex CLI 0.162.0-alpha.2; macOS 27.0, Node 25.2.1; `gpt-6.1-sol`, `low` | Historical full six-role runtime observed on 2026-10-08 | Built-in Codex for orchestrator, worker, approver, teamlead and reporter; constrained Codex provider for reviewer; shipped worker/reviewer/approver pipeline |
| Codex CLI 0.162.0-alpha.17.2; `gpt-6.1-sol`, `high`; isolated native reviewer transport on 2026-10-11 | Permission proof measured | Effective `readOnly` / `never`, private home, disabled features and no MCP; bounded read, outside-root refusal and actual patch sandbox denial; matching canary hashes and child cleanup. Installed-plugin reload and full BB workflow on this version remain unmeasured. |
| Mixed native reviewer and BB workers | Partial | Does not establish the full BB profile |
| Cursor and OpenCode ACP workers; Cursor ACP approver | SDK fixtures | Selection, provisioning, authenticated tools, recovery and current predecessors; separate from a live model workflow |
| Other providers, versions, hosts, models/efforts or custom pipeline shapes | Unverified or unsupported | No full support claim; Unadmitted providers and remote environments refuse |
| Package delivery | Source-only, unreleased | Build this checkout and a matching packed library; the root package tarball excludes the optional plugin |

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
