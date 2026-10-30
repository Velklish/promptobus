# ADR-040: One authenticated workspace service for MCP and warden

**Status:** Accepted
**Date:** 2026-10-30
**Deciders:** the owner selected workspace scope, combined MCP/file service, launcher-based startup and idle exit on 2026-10-30; implementation boundaries are recorded below.

## Context

The stdio bus configuration starts a process for each MCP client. Reviewer file
tools have a second stdio entry, while the CLI warden starts a detached process
for each task. Sharing a filesystem journal does not share those processes.
The owner requested one physical MCP/warden process across the sessions of one
workspace, with separate logical tools and rights.

A long-lived process cannot use its own environment as every client's identity.
The existing Host permits callbacks that capture cwd, and harness registry homes
have a process binding. Reviewer directory grants can include project configs,
task files and other nominally private files; file mode 0600 does not protect a
credential from an admitted read by the same OS user.

## Options

- **Scope:** a machine-wide daemon would have to arbitrate unrelated workspaces,
  versions and failures. A canonical workspace/store owner retains isolation.
- **Lifetime:** a permanent OS service preserves direct client startup but needs
  OS installation and recovery. A launcher starts the listener before the client
  and permits idle exit. A stdio proxy per session retains the process cost.
- **Authority:** caller-selected role headers or one shared bearer would mix
  clients. Owner-issued immutable grants retain each client's coordinates and
  read ceiling. Credentials inside project/task read roots expose that ceiling's
  authority to the reader itself.
- **Host:** one global mutable Host would transfer consumer state between
  clients. A consumer-owned factory constructs immutable client contexts while
  common harness homes/binaries are validated as a service invariant.

## Decision

One physical service is keyed by the canonical workspace and store supplied by
the Host. It serves the bus and reviewer_files through separate logical
Streamable HTTP connections and runs the task warden state machines. Each task
retains its own journal seat, watcher, deadlines and cleanup; stopping one task
does not stop the process used by another.

The MCP listener binds loopback only. Owner control uses a private local socket
in the same process; it never sends owner credentials or registration bodies to
the retained TCP port, which could belong to a foreign listener after a crash.
Atomic discovery/startup admits one owner,
checks the runtime and consumer entry identity, and retains the endpoint across
idle exit and crash. An incompatible owner or occupied retained endpoint is an
actionable refusal, not permission to start a second owner at a different port.
Discovery exposes identity and location, never authority-bearing credentials.

The existing CLI entry adds service lifecycle commands and accepts a
consumer-owned Host factory in its options. PromptobusHost, package specifiers
and existing runtime paths remain stable. Every grant stores its own Host,
cwd/environment, fixed authority coordinates and file ceiling. Identity refresh
uses owned native/session records. Dispatch never switches process.env,
process.cwd or the process's harness bindings between clients; implicit identity
defaults run in lexical client scope.

Only the private owner control authority can register, bind or revoke clients.
A client bearer cannot select a foreign role, task, launch or root. Owner and
client credentials live in private user state outside every canonical directory
and exact-file reviewer grant; overlapping grants are refused. Descendant
launches discard ancestor credential variables before receiving their own grant.

Real managed launches reserve a client and ensure service readiness before
starting the harness. Root sessions use the package or consumer launcher.
Planning and dry-run do not start the service. The root launcher must hand off
execution without a permanent per-root Node proxy. An ordinary HTTP config
cannot restart a listener that exited while the client was absent.

Crash recovery is preflight-first too. The owner runs service ensure, or the
consumer repeats its preflight, to start the retained endpoint; the already
running harness can then reconnect/reinitialize according to its native profile.
The launcher automates ensure at launch, not continuous monitoring afterward.
A fixture that invokes ensure after killing the process proves owner-preflight
recovery, not automatic native restart. Diagnostics and reconnect instructions
must name this trigger. A profile-specific hook may automate it only after that
hook and its ordering have their own proof; no OS watchdog or stdio proxy is
silently added.

Idle exit requires no startup reservation, live client or active warden work.
Client lifetime is independent of an in-flight HTTP request and optional SSE or
DELETE behavior. Root PID/birth proof and managed provider session/launch proof
are distinct; a transient launcher PID or wall-clock start stamp does not prove
a background participant's life. Unknown managed liveness is retained and
diagnosed rather than declared dead to obtain an idle exit.

Retained connection identity and mutation request state survive a service crash.
Retrying a known completed request returns its retained result; an uncertain
in-progress mutation is refused for reconciliation instead of blindly repeated.
This is not a general exactly-once claim across unrelated requests.

Managed installation/sync moves clients to HTTP and requires reconnect. The
former product stdio entries report the migration instructions; they do not
remain permanent fallback processes. Native BB dispatch, pause and epoch
authority retain their existing delivery path.

## Consequences

- Physical process count scales by workspace/store rather than client/task.
  Memory and latency savings require the same-workload measurements; TypeScript
  compilation itself does not establish them.
- Consumers supply the factory and launcher/preflight integration while the
  package owns transport, credentials, process lifetime and protocol state.
- A live client without a current request keeps its listener. Startup
  reservation, replacement, crash recovery and cleanup require explicit tests.
- Read-only reviewer grants cannot include the private credential tree, even
  when the requested review directory is a broad ancestor such as `/`.
- Supported native profiles need ordinary workflow evidence. Config syntax,
  source inspection and a fixture do not establish a live handover or native
  physical Stop; unavailable profiles remain explicit.
- The final consumer artifact and trusted manifest are handed over together.
  Source integration, local acceptance, consumer repin and release publication
  remain separate events.
