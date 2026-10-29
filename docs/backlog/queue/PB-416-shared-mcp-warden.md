# PB-416 · Share one MCP server and warden across agent sessions

- **Order:** 390
- **Scope:** [MCP and warden](../../reference/01-overview.md), [Host](../../reference/02-host.md), [CLI](../../reference/03-cli.md), [Drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-30
- **Dependencies:** none
- **Cost:** major

## Context

The owner requested one shared MCP server and one warden across agent sessions on 2026-10-30. The current participantMcp implementation creates a stdio subprocess for each client, while claimWarden owns one detached process per home/task pair. Sharing the on-disk store does not currently share those processes.

The owner interview selected one physical process per canonical workspace/store, automatic start on first use, and exit after idle time only when there are no clients and no active work. That process serves bus MCP and reviewer_files and runs the shared warden. Logical tool names and per-client rights remain separate. Managed installation/sync moves existing stdio configurations to HTTP with an explicit reconnect; the former stdio route reports the upgrade instructions instead of keeping a persistent fallback subprocess.

The investigation also found retained processes of closed tasks and temporary test stores. Cleanup and lifecycle verification belong to the design; a process disappearing is not a fabricated native Stop receipt. Migration of existing implementation to TypeScript is tracked separately in PB-415. New implementation should use TypeScript and the agreed build layout.

## Work to do

- Use the confirmed per-workspace scope, on-demand lifetime, combined bus/reviewer_files process and coordinated HTTP migration. Obtain approval of the execution plan before production code changes.
- Define the shared process entry point, concurrent-start ownership, discovery, version compatibility, shutdown and crash recovery. Keep workspace knowledge behind the Host contract rather than copying consumer workspace rules into Promptobus.
- Serve the bus MCP tools to multiple clients without one long-running bus subprocess per client. Preserve each client's task, address, launch and permission binding; process-global environment identity cannot serve as multi-client authorization.
- Run the task-specific warden state machines in the shared warden, preserving mailbox routing, aliases, wake delivery, retries, deadlines and ownership checks.
- Update all supported harness launch configurations and the installation/upgrade path. Treat reviewer file tools and Codex holders as separate responsibilities and make their process ownership explicit.
- Reconstruct the consumer-owned Host through its launcher and keep the context explicit on the service instance. Do not serialize arbitrary Host callbacks, trust caller-supplied roles, or switch process-global harness bindings between HTTP clients.
- Keep native BB engine calls and its dispatch/pause/epoch authority on their existing delivery path. Sharing the CLI MCP/warden process does not grant it ownership of native BB delivery.
- Preserve the filesystem journal and recovery contracts, CLI/library behavior and consumer-facing package paths unless a specific contract change is agreed and documented.
- Split implementation into independently accepted child tasks with independent subagent review. Fix critical and major findings before acceptance and register minor findings with evidence.

## Out of scope

- Running the shared service on a remote host, supporting multiple OS users through one authority, or changing the journal into a network service.
- Changing models, subscription routing policy, worker/reviewer powers or task ownership semantics.
- Rewriting consumers such as the private workspace consumer in this repository or silently adopting an unverified MCP protocol version.
- Reducing the number of agent harness processes by sharing their model sessions.

## Verification

- Multiple simultaneous client sessions and root/child tasks use exactly one bus MCP server and one warden in the agreed scope. Counts distinguish bus processes, harness processes and purpose-specific file tools.
- Concurrent first starts produce one owner; restart after a crash restores delivery from retained journals without duplicate message commits or crossed identities.
- Foreign, expired, replaced and incorrectly scoped client bindings are refused before side effects. Reviewer restrictions and teamlead aliases remain enforced.
- The owner-selected idle/shutdown behavior leaves no owned service or fixture descendants behind. Forced termination is reported separately from a confirmed native Stop.
- Ordinary public workflows pass for the supported harness/role profiles; unsupported or unavailable live profiles are named explicitly rather than inferred from configuration syntax.
- Compare process counts, memory footprint and command/message latency against the same baseline scenario with explicit ownership and cleanup.
- The configured gates pass on the integrated committed source, and final independent review has zero critical and major findings. Every remaining minor finding has a backlog entry and evidence.
