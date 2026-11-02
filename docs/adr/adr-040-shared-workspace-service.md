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
malformed or literal `null` state or nonprivate/symlinked records refuse. Darwin
process birth uses full parsed `ps lstart` at second precision with fixed C locale
and UTC. Linux birth includes a versioned boot identity, PID namespace and start
ticks, after checking procfs self stat/status PID and the single namespace PID
against the observer's own PID. An ancestor-mounted procfs view is unknown.
Sync and async observation share the same parser and comparison semantics.
Only comparable captured observations can prove old lifetime exit; old private
candidate layouts, invalid records and changed observer namespaces are retained
as unknown for authority and reclamation, without a PID-only ESRCH fallback.
There is no transparent live-upgrade or migration procedure for those earlier
unreleased HTTP candidate states. File modes and nonces
provide owner coordination, not cryptographic isolation from a same-UID shell.

The later native guard must prove the first canonical SessionMeta, an explicitly
permitted `cli` or `vscode` source, the exact approved native store, actual
app-server PID/birth/nonce and singleton native binding before invoking this
module. Its realization callback must commit the private native capability
while the admission lock is held. The BB bridge must use the same canonical
workspace/store and private service base for begin/completion, and include
existing authoritative state in its complete lookup before activating profiles.
Native guards, SDK wiring and profile activation require their own workflow
evidence. Process fixtures establish the filesystem transaction only, not native
workflow or physical Stop behavior.

### Portable native roots and recovery

The package's POSIX `promptobus-root` and a consumer's existing launcher use a
private one-shot exec plan. Preflight output is a pathname captured by the
launcher, never a diagnostic or timeline record. The plan contains references,
not a plaintext bearer, deletes itself before exec, retains cwd/literal argv and
does not leave a Node proxy. Dry-run only reads supplied approval state. Managed
children discard every inherited root/client reference before obtaining their
own grant. Unlink does not revoke a grant; interrupted owned plans are removed
only after positively observed process death, and unknown/foreign state remains.

Standalone approval is a separate trust boundary from the BB profile. The
additive `approveStandaloneRootProfile` export names a direct native executable,
actual account store and harness. The immutable launch observes a registered
POSIX shell's PID/birth crossing exec to the approved native image. Native
SessionStart must originate from that process or its checked shell hook child.
Before that hook, discovery stays pure and tools refuse. Codex requires the
first SessionMeta in the approved store and actual thread metadata on every tool.
New Codex `exec [controls] [--] <prompt>` requires first SessionMeta source `exec`; the accepted
new `--no-daemon` TUI forms require source `cli`. An explicit resume of an already
known current-version binding retains its creation source (`exec` or `cli`),
including when an exec-created session is later resumed through the TUI.
Editor sources and unknown unbound identities remain unsupported.
Image observation is asynchronous and bounded; Linux
uses its kernel process executable link, Darwin the system JavaScript/ObjC
libproc observer. Missing or unobservable proof refuses rather than trusting
argv, process names, ancestor labels or inherited environment.

Codex TUI/resume uses an explicitly supplied `--no-daemon`; `exec` uses its
in-process native route. This profile does not inject hidden flags, adopt a
shared daemon or implement remote/background lifetime. Claude uses its native
`headersHelper` and ordered SessionStart. Cursor's script-to-Node chain and
OpenCode shell-root identity need separate proofs. Installed ordinary workflows
are required for each supported route before retiring its stdio entry.

One private native ledger shares `root-admission.lock`; it adds no global
registry. Its uniqueness claim covers accessible bindings for one canonical
owner root/home and actual native store, keyed by harness and actual ID. A
physical generation uses its immutable nonce/launch ID, independently of client
capability IDs. Same-generation publication may refine missing provenance.
Potentially matching unknown provenance refuses; unrelated harness/ID bindings
remain independent. Accessible pre-ledger task/session/root history is read too.
Different trusted canonical native stores remain independent even for one
harness/ID. Service-client and available-record checks use exact owner publication
and immutable generation provenance; raw account/env hints cannot establish a
foreign store. Unknown stores conservatively conflict only with potentially
matching identities. A same-generation writer cannot change an already known
store or captured process.

Explicit owner/profile approval initializes version-2 native and root state before
new publication. Initialization selects the new-state policy, not empty native
history. Missing initialized files, JSON `null`, corrupt or older state and an
unmarked retained ledger refuse without replacement or migration. Generic owner
presence, a nonce, timestamp or native session ID cannot supply native genesis.
Managed Codex's store is the actual child's private `codexHome`, not its
credential source `authOwnerHome`. Only the owned correlated `thread/start` can
establish a first Codex binding; `thread/resume` requires a known predecessor.
Sidecars retain the same immutable primary tuple while its filesystem revision
may advance. Standalone NEW admission combines exact actually exec'd command
mode with the actual native hook/transcript/store and current executable proof.
Codex ordinary exec/embedded TUI use ThreadStart; foreground Claude also requires
actual startup source and a same-ID owned regular transcript. Unknown selectors
and old IDs refuse; installed-version ordinary verification remains separate.

BB admission reserves this ledger inside its existing outer lookup/realization
transaction. Service realization must not reacquire that lock for a BB callback.
Managed and standalone control operations acquire it themselves; no caller
supplies a `lockHeld` authority flag. BB successor intent is its actual native
SessionStart and fresh complete eligible host-wide lookup for the same approved
profile/store and canonical BB thread/native ID. The exact old captured lifetime
must have positively ended. Reliable different birth in the same verified view
or terminal Z can prove that exit; a new occupant is neither signalled nor awaited.
Live same-birth, unknown and incomparable observations refuse. One successor is
reserved before callback and exact repeats stay idempotent.

Standalone concrete-ID native resume argv is explicit owner intent. Old process
death and retained matching history use that same captured-lifetime policy for
both bound and pending generations before one pending successor is reserved;
the new actual exec/hook must prove the requested ID. Picker/latest,
names and interactive selection are not silently reinterpreted as concrete-ID
intent. Managed resume uses its existing owner-approved resume capsule, exact
old record/scope/store/ID and captured old death. Birthless old records and
unknown concrete resume IDs refuse without migration. A failed dead intermediate
generation may reconcile an exact restored predecessor, retaining that lineage.

Revocation is irreversible for a client ID, not an automatic corruption of its
immutable native identity. Same-process recovery requires explicit owner
`service preflight --standalone --profile ... --native-id ...`, current exact
process/image/store proof and a trusted durable owner hook receipt. The ID is a
selector. An actor launch file alone is not that receipt. Checking in-flight
mutations, fencing the old token and reserving one new pending capability is
atomic with respect to service dispatch. Recovery state survives interruption;
an explicit repeat completes its existing pending reservation. Native helpers
do not rotate capabilities after 401/403. A missing first hook requires fixing
the hook and restarting through the launcher.

Root request receipts live under the native generation and MCP session. Client
revocation, session removal, owner restart and native resume do not erase an
uncertain mutation. Such outcomes block recovery/succession until reconciled;
completed outcomes do not revive an old token. This is still not a general
exactly-once claim for arbitrary new operations.

Historical all-ever BB reconstruction and legacy migration are outside this
new-state contract. Their unpublished refresh callback is removed. Existing BB
host-wide identity fences remain; a new BB thread alone is not native genesis.
The optional trusted ordinary create callback on existing profile approval
reserves an operation, runs the SDK outside the owner lock and CAS-binds its
returned BB ID. An early actual native proof remains pending until that binding,
then the same owner preflight rechecks it without another spawn or hook. Pending
and uncertain operations never auto-spawn; known new bindings retain their
explicit successor/reconnect protocol. Missing history
never becomes empty history, and no reset, deletion or alternate credential path
is an admission mechanism.

The existing approval input also accepts optional
`executionScope: { project, environment }`, copied as exact nonempty strings
before its first await. The same creation record retains this pair with its
operation revision. Every approval/repeat checks it under the owner lock before
preflight: another project/environment or scoped/unscoped mismatch refuses,
including callback-free approval. Omitting `createRoot` remains profile-only and
cannot realize an existing operation. The original profile/owner, operation
revision and execution scope fence SDK completion and retained early-hook
recovery; no changed request retargets or respawns a root. This tuple selects
execution intent, not native identity or creation proof. The SDK callback remains
outside the owner lock and the existing third `env` argument is unchanged.

Managed non-Codex first publication now uses each actual owned producer.
Claude combines startup source with its captured command/store and actual hook
process. OpenCode's own default serve child receives an absolute filesystem DB
selection and excludes simulation; its actual create response is version/CAS
bound to that child/endpoint before first prompt. Cursor's own create-chat result
feeds only the same-ID persist route. Its asynchronous hook is correlated with
the actual pane and source-selected SQLite store; a current process descriptor
for the initialized file rules out path-only/memory-fallback claims. Native
transcript/data roots and Cursor's persist hash are not this native store key.
Pending tools refuse before realization of the same credential. Unknown creation,
admission or mutation outcomes retain primary/native state without auto-spawn or
mutation replay. These are source mechanisms awaiting ordinary native proof.

### Task loops and background observations

One package-owned Worker thread runs all task loops and native provider
observations. The consumer entry is never replayed there, and arbitrary Host
callbacks are not serialized. The original owner Host formats stall reports in
main through one typed request; the Worker receives the resulting text.
Each task keeps its own abort signal, watcher, heartbeat and journal seat. Its
map entry remains until the loop's actual `finally` completes, including an
activation already in progress. Demands received after a loop's start coalesce
into one successor after that cleanup, including natural completion before main
handles the completion event. Explicit abort cancels outstanding demand unless
a later request renews it. A live legacy per-task PID is busy even with
a stale heartbeat; the shared service neither takes its seat nor kills it.

Private demand state records whether a task still needs a loop. Recovery reads
only outstanding demands, rather than restarting every journal marked `active`.
A completed no-work loop consumes its demand; a new write or explicit `warden`
command requests another. Pending task work and provider observations count
toward service lifetime. A failed Worker closes the owner for explicit preflight
recovery, rather than replacing it under the same PID while old seats remain.

This isolation follows an owned blocking fixture: with a 1200 ms provider
inspect, authenticated HTTP pings took 1223–1230 ms while the loop ran in main,
and 54–58 ms while it ran on the Worker (baseline 54–58 ms on that run). These
are local fixture measurements, not a latency SLA or native-model benchmark.
Explicit user `status` or mailbox operations may still make synchronous driver
calls on main; background reads serialize on one Worker and can delay each
other. Root PID/birth checks use asynchronous OS reads independently of that
queue, and admit a process only after verifying its actual birth identity.
The Worker uses the package's supported Node 26+ API; see the
[Node Worker documentation](https://nodejs.org/docs/latest-v26.x/api/worker_threads.html).

Managed observation never creates authority. Main checks immutable task,
address, ref, launch generation and owned record before dispatch. Provider reads
are accepted only if the record's filesystem revision remains unchanged before
and after observation and at reacceptance. That revision is a stability check,
not OS birth or launch authority. Missing, corrupt or changing evidence retains
an unknown client and refuses its tools until proof returns; only verified
replacement or death permits retirement.

### Common poll context

The service fixes registry homes, actual driver binary names and one poll
environment at startup. Every owner registration must match it. The internal
owner API accepts optional `ServiceCallOptions.pollEnv`. For cold startup this is the full root
owner environment, preserving consumer-specific settings and common account
config such as `CODEX_HOME`; it is not a finite patch over a managed caller's
environment. Known actor task/role, native identity, record and contact variables
are removed from the startup snapshot. Service location uses the caller's
canonical private registry; idle/reservation settings and execution traces may
be overlaid from that caller. The owner starts at the canonical Host workspace,
regardless of the caller/preflight `ServiceCallOptions.cwd`. Client cwd remains
the explicit `ServiceClientInput.cwd` and is not changed.

A managed caller, proven by a non-root role or session-record pointer, cannot
cold-start an owner without this common snapshot. It receives an actionable
owner-preflight refusal before any child is spawned. An ordinary unbound root
may use its own environment as the default, with the same actor-field removal.
Ready compatible owners may be reused without another bootstrap; subsequent
client/demand context validation still applies. A launcher
preparing private native config must capture this root/common context before
that preparation and pass it separately; neither a client's private config nor
its identity may silently become the shared poll context.
Client registration uses `ServiceClientInput.pollEnv` for common-context
compatibility independently; its `env` and `cwd` remain client-specific.

Only background native polling uses a finite projection of this environment.
`lib/harness-home.ts` owns that exact projection:

- Account/home: `HOME`, `USER`, `LOGNAME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`,
  `CLAUDE_CONFIG_DIR`, and `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
  `XDG_CACHE_HOME`, `TMUX_TMPDIR`.
- Execution: `PATH`, `Path`, `PATHEXT`, `ComSpec`, `COMSPEC`, `SystemRoot`,
  `WINDIR`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`,
  `NODE_OPTIONS`, `NODE_USE_ENV_PROXY`.
- Transport: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their
  lowercase forms, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`.
- The `ANTHROPIC_` and `CLAUDE_CODE_` prefixes, except the four native contact
  keys `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`,
  `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`.

Unlisted client variables are not forwarded to shared polling. Verified harness
registry homes and the optional owner execution trace path are added separately.
If the common context omits config and home variables, the OS user record supplies
the home; ambient daemon home overrides do not become an implicit poll profile.
No per-client mutation of process environment, cwd or global Host occurs.
The background session cache is keyed by the resolved binary and this context;
each task/provider snapshot resets it before observing current state.

### Late Claude contact handover

The poll context excludes native socket/token identity. If a known Claude
contact has a token, a handover with no socket or no token preserves that entire
known socket/token pair. A different socket without its token cannot receive
the old token. An initially token-less profile can still register its contact.
Foreign sessions and replaced immutable launch generations cannot transfer
contacts through an old HTTP grant.

Managed launch wiring must issue a new generation marker even when a resume
reuses the same native session ID, replace the old generation's contact, and
deliver a complete fresh owned socket/token handover. This loop/service change
does not invent native IDs or derive them from the daemon's startup environment.
Native profile launch/hook wiring remains a separate integration boundary.

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
