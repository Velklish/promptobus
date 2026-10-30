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

### Owner lock release

Acquisition and release use the same core gate around the active owner lock.
Both gate transactions are synchronous: process-birth observation and filesystem
publication on acquisition, nonce comparison and removal on release. No awaited
callback, HTTP request or native provider operation runs under this gate. Gate
contention uses the core lock's existing bounded synchronous wait; this does not
establish a responsiveness guarantee. Acquisition still returns a promise, and
release remains a synchronous callback. A live or unknown active owner returns
busy so callers can wait asynchronously outside the gate.

A contender cannot lose owner proof to a cooperating release between checking
the active directory and reading its owner. Release removes only its matching
nonce; a replacement generation retains its proof. A genuinely missing or
corrupt owner still refuses acquisition and preserves the lock for inspection.
Controlled owned-process fixtures establish this ordering and retention, not
the cause of an earlier CI refusal.

### Root profile admission

The private owner module `lib/root-admission.ts` records explicitly approved
native account/session-store profiles for one canonical workspace/store and
runtime. Profile IDs are scoped names, never paths or caller authority. Repeating
approval of the same ID and canonical native store is idempotent; changing the
runtime or native store requires another explicitly approved ID. Possession of
a private native store, missing role variables, public origin/parent fields and
plugin metadata do not approve a profile.

One `root-admission.lock` under the workspace/store service directory serializes
profile approval, root admission and managed launch publication. The owner must
call `beginManagedLaunch` with a fresh intent ID and await its persisted result
**before any provider SDK spawn or preparation dispatch**. This operation admits
only creation of a new BB thread; it does not authorize adoption of an existing
thread. After spawn returns one canonical BB thread ID, the owner calls
`completeManagedLaunch` to publish its permanent exclusion and resolve the intent
in one transaction. Repeating completion with the same intent and thread is
idempotent; repeating begin must not spawn again.

`realizeRoot` holds that same lock across a trusted owner lookup and the awaited
owner realization callback. The lookup receives the approved canonical scope
and exact native generation. Its positive result must be
`{ complete: true, eligibility: 'eligible', bbThreadId }`, with one canonical BB
thread ID. Complete means that authoritative existing BB participant bindings
and launch intents were read for this scope, including legacy records and every
preparation, starting, ready, orphan and archived phase. Public native identity
events establish correspondence, not eligibility. An empty new exclusion table
or a negative public mapping alone cannot classify a legacy actor as unmanaged.
An unavailable, incompatible, corrupt or ambiguous owner lookup refuses admission.

The root classification is persisted before the realization callback runs and
is retained if its outcome is uncertain. No managed publication can occur
between complete-negative lookup and realization. The same native generation
cannot change its BB correspondence or approved profile. Existing root adoption
is unsupported: completion refuses a BB thread with any recorded root
classification and retains its intent; the module has no operation that claims
capability revocation or removes this classification.

An unresolved managed intent blocks new root admission across all profiles of
the workspace/store, even if its launching process died. An SDK exception does
not establish that no thread or preparation dispatch occurred. The owner must
reconcile the actual SDK outcome and complete that exact intent with the
canonical resulting BB thread before the block is resolved. An outcome with no
recoverable unique thread requires explicit owned inspection; no automatic
abandon operation removes it. Completed exclusions survive phase changes,
archival and later native generations of the same BB thread. PID death only
permits reclaiming a proven dead process lock; it removes no classification.

State is stored below `servicePaths.base`, which existing reviewer grant checks
exclude for directory, ancestor and exact-file grants. The module uses the same
private directory/file checks, atomic record writes and process-lock machinery
as the service. A missing state file in an initialized admission directory,
malformed state or nonprivate/symlinked records refuse. Darwin process birth is
the existing `ps lstart` observation at second precision. File modes and nonces
provide owner coordination, not cryptographic isolation from a same-UID shell.

The later native guard must prove the first canonical SessionMeta, an explicitly
permitted `cli` or `vscode` source, the exact approved native store, actual
app-server PID/birth/nonce and singleton native binding before invoking this
module. Its realization callback must commit the private native capability
while the admission lock is held. The BB bridge must use the same canonical
workspace/store and private service base for begin/completion, and include
existing authoritative state in its complete lookup before activating profiles.
Those integrations, native proofs, profile activation and SDK wiring are not
implemented here; current launch paths are not protected by an unused module.
Process fixtures establish the filesystem transaction only, not native workflow
or physical Stop behavior.

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
