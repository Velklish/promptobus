The plugin binds local task participants to authenticated BB threads and exposes
native mailbox, typed send, task and artifact tools. The canonical v1 engine runs
on the local coordinator host; the server keeps identity rows in plugin storage.
It also adds a Codex reviewer provider that reads source through bounded native
tools and refuses shell execution, source edits and unclassified external tools.

## Requirements

BB 0.45.0 or 0.46.0, Plugin SDK 0.6.15 and a signed-in Codex account are required.
The reviewer admits Codex by its effective restrictions and supported protocol capabilities, without a numeric version bound. Execution and file reads use one local host. Each reviewer receives a
private Codex home and an empty project sandbox. Existing native providers keep
their own behavior.

## Review permissions

The provider verifies Codex read-only sandbox and no approval escalation before a
model turn. BB's Accept Edits label does not grant writes through this provider.
Four bounded file tools read the authenticated thread's environment. Bound
reviewers also receive authenticated bus tools; these write task journals only.
Canonical reads use the authenticated Host bridge and a consumer-owned adapter;
fresh complete classification excludes writes before consumer dispatch. Native MCP
remains disabled. Full Host rules and canonical skill text enter the first assignment,
including new BB worktrees. The source generator creates a consumer plugin variant;
the default variant uses the standalone Host and refuses declared servers without an adapter.

`bb promptobus task create`, `participant add` and `bindings` use an existing
unmanaged Git coordinator on the primary local host. Participants can reuse a local
environment, register an existing absolute local Git worktree with
`--environment-path`, or ask BB to create a managed worktree. Path registration
and new worktrees, plus reused Cursor/OpenCode environments, use the participant's own bounded preparation
turn without assignment or plugin tools, then confirmed Stop, cleared preparation
model context and authoritative
binding before the first assignment. Stop retains the environment; archive preserves
a complete patch in the coordinator before BB retirement. Orphaned launches receive
no bus rights. Wake hints refer to canonical unread messages; SDK delivery does not
ACK them. Reload replays history and reconciles a bounded outbox without spawning
again. Plugin participant Stop durably pauses automatic continuation until resume;
ordinary BB Stop on an already-idle thread has no replayable SDK pause marker.
Active interruption and denied interactions also pause continuation.
Path registration verifies the actual project, host, normalized path, Git HEAD and
thread lifecycle before canonical reservation or assignment. It retains existing
workspace ownership; null environment ids and ambiguous replies remain failed
launches with recoverable intent. Deferred spawn is not provisioning. Existing-path
coverage is SDK fixture evidence; a live registration has not been measured.
Selection records runtime, provider, SDK/native model and reasoning from a scoped
SDK catalog. Workers admit explicit Cursor/OpenCode ACP providers, and approvers
admit explicit Cursor ACP; default and governance roles remain Codex, with a
separate constrained reviewer. These paths have SDK fixture coverage. Selected
MCP tools export object input schemas, including the strict Host context union.
Live OpenCode verification covers authenticated task, mailbox and send calls.
Cursor server availability is verified; authenticated calls under a genuine user
turn with **Allow once** remain unverified. BB denies approval escalation on
agent-initiated turns before publishing an interaction.
Explicit provider choices must match the role; no provider fallback
or native strategy substitution occurs. Account windows belong to that provider
on its host; absent reviewer usage remains unknown. The six-role runtime was observed together on the local source profile: macOS
27.0, Node 25.2.1, `gpt-6.1-sol` with `low`, and the shipped worker/reviewer/approver
pipeline. Worker and approver tested the actual committed candidate; reviewer and
reporter write denials preceded callbacks. Explicit operator queued inputs may
run while automatic delivery is paused. See README for setup, source-only delivery
and measured limits; custom profiles carry no full support claim.
