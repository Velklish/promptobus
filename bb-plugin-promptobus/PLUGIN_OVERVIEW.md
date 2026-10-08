The plugin binds local task participants to authenticated BB threads and exposes
native mailbox, typed send, task and artifact tools. The canonical v1 engine runs
on the local coordinator host; the server keeps identity rows in plugin storage.
It also adds a Codex reviewer provider that reads source through bounded native
tools and refuses shell execution, source edits and unclassified external tools.

## Requirements

BB 0.45.0, Plugin SDK 0.6.15, Codex CLI 0.162.0-alpha.2 and a signed-in Codex account
are required. Execution and file reads use one local host. Each reviewer receives a
private Codex home and an empty project sandbox. Existing native providers keep
their own behavior.

## Review permissions

The provider verifies Codex read-only sandbox and no approval escalation before a
model turn. BB's Accept Edits label does not grant writes through this provider.
Four bounded file tools read the authenticated thread's environment. Bound
reviewers also receive authenticated bus tools; these write task journals only.
Canonical
external tools are withheld until classified delivery is available.

`bb promptobus task create`, `participant add` and `bindings` use an existing
unmanaged Git coordinator on the primary local host. Participants can reuse a local
environment or ask BB to create a managed worktree. New worktrees use a preparation
turn without assignment or plugin tools, then confirmed Stop, cleared preparation
model context and authoritative
binding before the first assignment. Stop retains the environment; archive preserves
a complete patch in the coordinator before BB retirement. Orphaned launches receive
no bus rights. Recipient wake delivery, model routing and the complete role workflow
remain separate boundaries.
