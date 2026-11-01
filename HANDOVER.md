# PB-416.3 — Run task warden state machines inside the shared service

## Claim-publication diagnostic checkpoint

On product af9bf86b, shared-warden-failure first passed36/36, then failed35/36:
departure-note recovery reported exact=false, delivered=true and later ordinals
[2,2]. Two unchanged isolated repeats passed36/36 (exit0/0). Literal old-ac70
coordinator runs both passed this particular recovery assertion; their whole-file
20/36 failures were the separately demonstrated owner-control persistence bug.
The original recovery red remains unresolved. Its initial ordinals, seats boolean
and exact-computation operands were not retained, so its cause is unknown.
[2,2] names one ordinal for each task, not two successor lifetimes.

Source proves a possible premature observation: claimWarden publishes its mark
before bumping the ordinal under the task lock, while the fixture previously read
both without waiting for claim completion. This is a mechanism, not attribution
of the historical red. The diagnostic change is test-only; product bytes remain
af9bf86b. Before initial and recovery ordinal sampling, the fixture now requires
the exact owner PID/birth, coordinator running state and actual Worker started
event for each expected durable task/demand UUID. It does not poll for desired
ordinals. The original strict previous+1 and distinct physical successor predicates
remain in place; missing acknowledgment fails under the existing wait boundary.

Only the owned departure-note mechanism copy receives a Worker barrier between
mark publication and ordinal bump. A fresh review found the previous diagnostic
incorrectly assumed a fixed task reached this point last. The hook now keeps its
own fresh claim map and selects the claim that actually publishes the last mark
of the expected task set. Each mark must match that Worker's fresh claim timestamp,
the measured owner PID/birth and its exact task/demand UUID. Old marks with a reused
PID cannot satisfy a missing entry in the fresh map.

Two departure-note controls invoke the concurrent owner RPCs in AB and BA order.
The owned two-message Worker seam forwards starts in BA and AB order respectively;
it records received, forwarded and actual claim order. Sequential ensure is not
used as completion evidence. Initial and recovery packets must prove the
old mark-only predicate is true while the ordinal is still unbumped and the exact
started acknowledgment is absent. The fixture records the unpublished observation,
releases its own barrier, then waits for the actual completion acknowledgment.
Finally releases the barrier for fixture insurance. The hook adds no product
state transition or Stop allowance. Its exact emitted JS is checked separately.

Durable observation JSONL includes PID/birth, ordered observation sources, demand
UUIDs, initial/recovery ordinals, seats, full coordinator snapshots and the exact
comparison operands/reason. Historical missing fields are left unknown. Native
diagnostic runs and fresh whole-range review of this test-only successor remain
notRun at source preparation; previous reds and snapshots are retained separately.

## Owner-control durable demand failures

Fresh whole8e..ac70 review found 0 critical, 1 major, 0 minor: ensure/abort
changed volatile demands before persistence, and owner-control write errors missed
the common fatal path. A held stopping generation A could therefore schedule an
unpersisted generation B after ensure returned500 and durable required remained
false. No further current native/probe/full-gate work ran on that known-red source.

All four durable mutations now pass through setDemand: build a candidate Map,
persist it, then publish memory and schedule only after a normal return. Every
write exception enters the same memoized failed/owned-Worker-close path and is
rethrown unchanged. The callback remains constructor-bound and callable by the
owner methods. No compensating write or durable-file rollback occurs. The file
may hold old state, a committed new snapshot, or an unresolved write outcome;
HTTP500 alone does not distinguish these cases. Inspect the actual file and
receipts. Preflight resumes its recorded demand UUID, not a newly invented retry
generation. Invalid durable state still refuses startup.

| Entry / mutator | Memory, persistence and scheduling boundary | Error / late-callback behavior |
| --- | --- | --- |
| Constructor durable load | Validate schema/home/each demand before creating Worker; load existing disk snapshot only | Invalid file throws before Worker creation. No speculative rewrite or action. |
| Owner ensure | Validate active task; create candidate UUID/required=true; setDemand persists before memory/start | Any write error starts common fatal/close; no old-owner scheduling after refusal. A pre-replace failure cannot publish B; a committed B remains on disk for inspection/recovery. |
| Owner abort | Guard unavailable first; candidate required=false persists before memory/stopping/abort command | Write error starts the same fatal close. This close drains owned Worker resources; it does not claim the failed abort was a successful task outcome. |
| Worker successful settlement | Candidate required=false only for its current matching demand; persist before memory | setDemand error enters common fatal, and constructor catch reaches the same memoized callback. Durable intent remains authoritative. |
| Recover inactive task | Candidate required=false via setDemand | Same fatal/write-outcome policy as owner control. No later demand scheduled after failure. |
| Recover active task | After ready await, guard failure/closing, then start the existing durable UUID | No retry UUID minted. A fatal transition while ready resumes cannot start old memory-only work. |
| setDemand/persist | persist(candidate) is the only write site; memory set only after normal return | No rollback of a possibly committed file. Close performs no durable demand write. |
| Private start | Guard closing/failure before allocating or sending a generation | All actual start sites retain this final fence, including recovery and released Worker outcomes. |
| Released old settlement | Ignore absent/stale generation; no persistence/successor when closing | A queued A callback after fatal cannot use a rejected in-memory B. |
| Worker failure/error/exit | Common callback preserves its first error, rejects waiters and initiates memoized close | Later events cannot replace the original cause or start another close. Actual Worker exit remains required. |
| Repeated ensure/abort after fatal | Reject with the retained cause before writing or scheduling | No fresh UUID, candidate write or acknowledged new work. |
| Observe/format/diagnostics/legacy | No durable demand write; observation rejects/returns unknown when unavailable, and legacy diagnostics are not shared-loop ownership | No hidden persistence or recovery action in these callbacks. |
| close/closeWorker | Memoized abort/drain/close of owned Worker, await actual exit | No demand rollback or required=false compensation. Lock release still depends on the actual exit latch. |

Service client helpers send each owner-control RPC once. Explicit service preflight
can recover published intent; it does not resend a failed ensure/abort RPC. A caller
must inspect an uncertain write before issuing another action.

Test-first pure production-control-flow fixture covers ensure, abort, inactive
recovery and recovery continuation, each before/after replace; late callbacks,
repeated close, exact retained snapshots and successor UUIDs. Sourceac70 produced
18/40 exit1; preparation40/40 exit0. Existing cleanup unit17/17 exit0. These are
not native Worker/owner exit proof.

Prepared actual shared-warden-failure cases add owner ensure/abort before/after an
actual atomic rename. The ensure case first persists abort-A=false and holds its
actual settlement. Fault traces retain candidate UUID plus exact durable bytes,
then verify no old-owner post-error generation, actual Worker/owner exit, lock
release, late RPC/callback refusal and recovery from the actual persisted snapshot.
After-replace errors deliberately retain committed intent; they are not labeled
unpersisted from caller500. Original base8e has no shared task owner-control API;
the new causal comparison uses the captured ac70 coordinator product, while
original-base compatibility remains a separate measurement.

Prebuild emitter materialization checks the actual consumer/native templates and
both coordinator Function variants: six syntax checks, exit0. The prior 62
bounded/sampling generated JS/shell checks are linked with unchanged source
hashes; their Windows-only cmd wrapper remains notRun on darwin. Captured ac70
TS/JS/declaration hashes match its earlier build manifest. Native tests, fresh
review, committed probes and gates are required after this source checkpoint.

## Awaited bounded Stop observation and fallback repair

Fresh whole8e..cdd7 review found 0 critical, 1 major, 0 minor: the named tmux
fallback received a new synchronous default60000 budget. Supervisor also required
every pre-confirmation tmux observation to use awaited remaining-time execution.
The previous caveat about synchronous polling is superseded by this source change;
public synchronous readers outside Stop and native startup paths remain unchanged.

The Stop helper now awaits all native observations under one old edge, including
early native refusal, polling and the final fresh identity read before fallback.
The fallback itself awaits runAsync with remaining old-edge time. Unknown/error,
expired observation and cancelled fallback return retained UNKNOWN before another
native mutation or terminal reaping. No hidden observation allowance, specialzero
path or increased default was added. Registry-backed Stop captures exact stat
revision and native launch tuple, then checks them after every await and directly
before mutation. Driver retirement also fences its original revision and launch.

| Reachable Cursor Stop site | Effect / execution | Allowance and refusal |
| --- | --- | --- |
| Driver entry, liveBin, registry read/revision | Synchronous filesystem only; no version subprocess | Entry deadline begins before lookup. Cursor public default10000; live callers explicitly share5000. Missing record is scoped no-op, unread/changed revision refuses. |
| Initial native tuple | Awaited tmux list-sessions | Remaining original edge; unknown/expired result retains record. Name/chat and recorded pane/hash must match. |
| Process-tree preflight | Awaited ps -Awwo pid=,ppid= | Remaining same edge; command error/unreadable table/expired edge refuses. Revision checked immediately after await. |
| Native tuple after process preflight | Awaited tmux list-sessions | Same edge; fresh tuple and exact registry revision required. |
| Native agent persist stop | Awaited runAsync | Original edge checked before dispatch; remaining only. Revision checked after response, then fresh bounded observation is required. |
| Accepted-native polling and early-refusal observation | Awaited tmux list-sessions, bounded settle | Remaining same edge for each read; settle cannot intentionally exceed remaining. Expired/cancelled/unknown read grants no fallback authority. No synchronous default60000 read remains here. |
| Final pre-fallback tuple | Awaited tmux list-sessions | Remaining same edge, exact fresh native tuple plus registry revision. Resolve binary before this read; check record and edge immediately before mutation. |
| Named tmux kill-session fallback | Awaited runAsync | Positive remaining old-edge allowance only. Child killed by runAsync on timeout; failed/unknown outcome returns retained UNKNOWN before polling/reaping. No new60000 budget. |
| Post-fallback confirmation | Awaited tmux list-sessions | Remaining same edge. Unknown/expired result retains record. |
| Driver final readable absence | Awaited tmux list-sessions | Original driver deadline before/after await, exact original registry revision and native tuple/launch before drop. No expired observation can retire record. |
| Post-confirmed orphan discovery | Synchronous ps -Ao pid=,command= and candidate ps eww -o command= -p pid | Existing run default60000 per observational read, only after confirmed native absence. Direct SIGKILL requires worker-server command plus exact session-record environment marker. Separate cleanup residual, no renewed native Stop budget. |
| Post-confirmed tool descendants | Direct process.kill(SIGKILL), no subprocess | Captured before native stop. Separate post-confirmation cleanup residual; never reached from unknown observation/fallback. |
| Stamp/temporary launch pane kills | Synchronous tmux mutation outside Stop call-tree | Not reachable from driver.stop→stopSession. Startup repair in the other owned tree is integrated by parent; this change makes no bounded Stop claim for launch. |

Production callers: public `stop` and `done` call core stopParticipant, receiving
Cursor's default10000 without changing task-level sequencing. Live Cursor normal
and abort cleanup share one5000 participant deadline; mixed normal passes full
remaining to both drivers, and mixed abort retains its original Codex share.
Both live callers initiate their participant Stops before awaiting either. Once
one native absence is confirmed, its residual reaping may delay delivery of the
other completion; neither whole cleanup nor service close is claimed to be5s.
Report failed-lift cleanup permits only Claude/Codex (report explicit harness gate
and routing filter), and live-codex is Codex only. No Cursor reachability through
those callers. Raw private stopSession without a registry ref has only its supplied
fresh native tuple; production driver Stop always supplies its registry ref.

Prepared `cursor-stop-bounded.test.mjs` uses actual owned pane processes and native
command JSONL: delayed fallback child termination, no delayed later mutation,
unknown record/home retention and ordinary positive fallback. A separate held
post-native observation lets another actual participant initiate and confirm native
Stop before release; exhausted/cancelled observation and exact record rewrite
cannot authorize fallback. PID/birth and command ledgers are emitted before owned
fixture insurance. `cursor-stop-preflight` adds a registry-revision rewrite during
the actual process preflight; all existing wrong-identity no-signal cases remain.
Runtime is not claimed from this preparation. Pure boundary test reproduced the
old fallback error (cdd7-fallback-pure-red exit1); current bounded preparation
passed18/18, exit0 (`bounded-prep-pure18`), including binary lookup consuming
the absolute observation edge before subprocess dispatch. Read-only runtime typecheck
`npx --no-install tsc --noEmit -p tsconfig.runtime.json` exited0; startup lint0
retains one existing warning. Actual bounded native cases remain notRun.

The separate shared-service compatibility red was attributed before correction:
focused6/7 exit1; exact isolated cdd7 runs each60/60 before abort, exits1/1,
15.188/15.101s, at test354 `strictTaskFacts` waiting on an intentionally owned
journal lock. ORIGINAL base8e same filename passed81/81, exit0,24.482s.
Baseline fixture has a Host busArgv gate, while current uses an exact completed
request-receipt rename gate; their full61+/19- difference and loaded runtime
hashes are retained in shared-service-cdd7-attribution-plan.json and its diff.

Sampling correction preserves the matching completed response success precondition,
pre-crash exact started key/digest and live owner/holder PID/birth proof. It kills
only the positively identified owner, requires positively observed same-lifetime
death, then applies the original strict question count BEFORE restart or RPC.
The gate is not released before crash; uncertain/replay predicates remain intact.
No raw-journal bypass or fake authority was added. New source requires a new clean
freeze, old/current bounded native regressions, sampling rerun, meaningful committed
probes, whole8e..HEAD independent review and configured5/BB evidence. None of the
old reds is waived. Native/heavy is on hold until the next scheduled window.

The first09ef controlled old-cdd native attempt did not reach the target: generated
agent/tmux fixture templates contained an unescaped newline inside a JS string.
It exited1,1/8; only owned-pane/insurance ledger rows were present, and all six
panes were disposed after verdict. This is an apparatus failure, not causal proof.
Raw frozen09ef-oldcdd-bounded1 and exact generated-script SyntaxErrors/hashes
old09ef-syntax-stub-syntax.json remain retained. Three template escapes are fixed;
all three generated script bodies must pass node --check before the new freeze.
Product bytes remain09ef; old compiled runtime copies were not overwritten.

## Fresh managed HTTP operation authority repair

The independent full-range review of `8e9bd6d4..01254578` found 0 critical,
1 major, 0 minor: a pending managed observation or prior cached alive state could
authorize a new mutation while the shared Worker was busy and its native holder
was already dead. This section supersedes the readiness of the previous candidate;
its raw checks remain precursor evidence. Acceptance is open.

Status cache remains retention evidence only. Every HTTP admission now awaits a
fresh exact-record-revision native result and returns a synchronous grant/native
identity fence. Unknown returns HTTP 503 without deleting the credential, session
or prior receipts. Current native identity excludes mutable ownership metadata,
so an admitted mailbox claim can finish its existing binding/read continuation.
Record revision, native reference, session ID, harness and launch ownership remain
required; no automatic revision rebasing was added.

Managed dispatch alone enters a private synchronous lock scope. It first takes
its own task lock with zero wait, before creating a request receipt. All nested
sync target, alias, blob and message-order locks refuse contention immediately
and check the current fence after acquisition, including reentrant locks. The
existing sidecar lock hook also checks after suspending the task cache. The scope
restores its prior callback on return or throw; it spans no HTTP/SDK await and
does not change ordinary sync, async or stdio lock policy. It exports no new
index, Host or package entry symbol. It is not an atomic OS-liveness transaction.

Before-dispatch contention returns HTTP 503 with no new receipt. Later contention
can follow a partial effect, such as reporter `user` registration before message
commit. Existing started/completed receipt semantics remain; saved outcomes are
not silently replayed, and issuing a new request requires owner inspection.

| Lifetime/admission site | Authority or retention boundary |
| --- | --- |
| `state`, foreign-runtime retention, idle work | Cached alive/dead/unknown decides retention; unknown retains clients and recovery state. No operation authority. |
| Owner `register`, `bind`, `realize`, `revoke` | Private owner credential controls preparation/binding/removal. Existing matching record and process validation stay separate from public operation authorization; unknown preparation is not a client mutation grant. |
| Bearer authentication, GET/DELETE, POST after body | Fresh observation followed by exact current grant/native identity and record revision fence. DELETE has no intervening await before removing its own session. |
| Initialize and initialized notification | Repeat fresh admission after body, before writing connection state. Pending native binding still permits discovery without constructing an actor Host. |
| Deferred Host factory and final dispatch | Revalidate after factory completion, then acquire another fresh proof after all asynchronous preparation. Status TTL and pending results cannot substitute. |
| Request receipt, direct tool, saved response | Final fence precedes dispatch; own task lock precedes new receipt. No cached-alive authorization for replay. |
| Nested target/alias/message locks | No intentional synchronous wait, exact grant/revision/native identity fence after each acquisition; task cache suspended under the own task lock. |
| Tool self transitions | MCP has ask/send/mailbox/task-read, no task close or owner revoke. Mailbox claim changes owner/binding but not native launch identity. Native record change remains a refusal. |

Claude's legacy `bindHandshake` can write `sessionId`/`boundAt` to an unbound
record. Its ordinary prepared pointer has no managed `launchId`, so it is not
eligible as this managed grant proof; no speculative record-revision allowance
was added. Existing managed/native binding compatibility tests remain required.

Prepared actual regression: `test/shared-service-operation-authority.test.mjs`.
It uses a real Worker blocked in an owned provider process, actual owned holder
PID/birth exits with both unchanged and dead-marked records, exact journal/receipt
checks, held actual observation delivery for revision drift and transport refusal,
before/after-effect contention, explicit request recovery and an orchestrator
mailbox claim. Runtime results are not claimed from source preparation.

Light commands before freeze: `node test/service-operation-authority.test.mjs`
first reproduced 0/8 exit 1 on source0125; preparation passed 8/8, then 9/9 after
adding owner-claim continuation. Final preparation results are 10/10 and 9/9,
exits 0/0, in `auth-pure-final` and `auth-lock-pure-final` receipts. The immutable
source0125 copy failed the final authority checks twice, 0/10 each, exits 1/1. Startup `npx --no-install backslop lint --require-adapter
codex` exited 0 with one existing PB-304.1 warning. Native regressions, probes,
build, full gates and BB on this repair remain notRun until the clean freeze and
scheduled verification window. Commands/SHA/streams are recorded in the same
durable `stop-budget` artifact directory; no prior red was waived.

Planned order: build; controlled0125 actual regression twice and a diagnostic8e
public dead-holder subset (base has no shared Worker); current actual regression
twice; focused compatibility; committed authority/lock and existing Stop/lifecycle
probes; fresh independent full8e..HEAD review; configured5 gates and pinned nested
BB install/test. Every source fix creates a new freeze; earlier receipts retain
their source SHA. No full gate runs concurrently with a probe.

First frozen84b build exited 0. The initial restricted native attempt refused
process-birth observation before admission; its setup refusal remains separate.
The approved scoped escalated controlled0125 run reproduced both dead-holder
mutations as HTTP200 with new questions, then aborted at a fixture reader:
`strictTaskFacts` itself needs the deliberately held message-order lock. The
fixture now releases each controlled contention lock after the HTTP outcome,
before sampling the journal; it issues no intervening request or replay. The
original stream remains `frozen84b-old0125-actual-escalated1.log` (4/9 before abort).
This correction changes only sampling, and requires a new frozen verification.

Worker branch: `pb4163-stop-budget`, workspace-relative tree
`sandbox/pb4163-stop-budget-20261101`.
This source preparation follows the independent review of
`8e9bd6d438e30a4e18990b50b4d4e20129453e44..3457ac81793f11ef0cbf073d922aa3b4a1981882`:
0 critical, 3 major, 0 minor. The commit containing this handover is a verification
candidate; acceptance, archive/fold, main integration and publication remain with
the approver. No existing task cards, dependency pins or locks were changed.

## Source boundaries

- Task-loop cleanup independently attempts watcher closure, departure-note write
  and owned seat removal. It preserves primary and cleanup errors, checks for a
  retained own same-PID seat, and never returns successful stopped after failure.
  A foreign seat is preserved. Worker failure messages retain aggregate causes.
- The coordinator distinguishes failed from settled. Failed work cannot consume
  a later recovery demand. Fatal failure starts one memoized owned Worker close;
  close still sends abort/close after persistence failure and waits for actual exit.
- Owner finally attempts the remaining cleanup after rejection. It releases its
  lock only after observed Worker exit. Unknown exit retains the lock and reports
  failure. Primary service failure remains visible alongside separate cleanup errors.
- Live Cursor uses a private scoped task/service fixture, not the completed warden
  CLI process group. Normal and abort share one cleanup promise and one 5000 ms
  participant deadline. Both native Stops start before either is awaited, using
  remaining time from the same start. Service closure has a separate boundary.
  Synchronous lifts capture owned refs before signals can run; cancelled waits and
  later native/bus writes are guarded.
- Live Cursor and mixed remove only their registered sandbox from exit cleanup
  and mark it unresolved before their first cleanup await. Unknown or a 30000 ms
  signal-handler timeout keeps record/home/sandbox across child exit and the next
  scoped sweep. Successful abort copies receipts and samples pre-exit state before
  explicit owned sandbox disposal. Normal cleanup disposes only after confirmation;
  SIGTERM joins already-started cleanup without another Stop/revoke or new budget.
- Cursor Stop retains fresh name/chat identity and exact recorded pane/hash checks,
  including replacement during asynchronous process preflight and before fallback.
  Native shutdown and named fallback each refuse dispatch after the original deadline.
  Explicit native refusal can reach freshly checked fallback while time remains.

`timeoutMs: 0` is valid and grants no native Stop allowance. No special zero path,
forced kill promise or hidden observation budget was added. Its observed behavior
changes from the old synchronous overrun: missing proof returns unconfirmed with
record retained. A missing registry record remains a scoped no-op, not physical
Stop evidence. Only post-confirmation orphan/child reaping and filesystem calls
remain outside a hard wall-clock guarantee and do not renew native Stop allowance.
The existing mixed abort share, native 5000 ms allowances, and 30000 ms handler wait
were not expanded. Live Codex was not changed without a demonstrated migration defect.

## Validation boundary

### Full-suite fixture follow-up

The frozen `54a0b0d6c7f0db2535c8ab5ba7b5bdc778af001b` completed 18 meaningful
probes and a separate pristine 44/44 baseline. Its configured gates returned 1:
3/5 gates passed, and `npm test` passed 210/215 files. The publicity audit also
found an absolute owner-home path in this handover. Exact evidence remains in
`frozen54a0b0-configured5-red-checkpoint.json` and
`frozen54a0b0-fullred-attribution-result-checkpoint.json` under the external
evidence directory below; these receipts are not relabeled to this successor.

The unchanged isolated current pair and literal base were measured for all six
subjects. Current/base exits were 0/0/0 for done-user, and 1/1/0 for the wiring
guard, ambient allowlist, copied OpenCode fixture, sandbox prefixes and publicity
audit. The old done-user full-red cause remains UNKNOWN: its `settled` and
generation operands were not printed. Passing isolates do not attribute it.

This follow-up keeps product runtime bytes unchanged. It updates the wiring guard
to check both memoized native forwarding and concurrent starts, registers only the
private synchronous authority frame in the ambient allowlist, copies the canary
module required by the encoded-path fixture, and registers two owned test prefixes.
The done-user fixture waits for running status of its fresh initial demand, bound
to the same owner PID/birth, task, mark and unchanged required demand UUID. Only
then does it take its single ordinal baseline, within the original 5000 ms wait.
The final equality, settled/exit-reason checks and owned physical cleanup remain.
The existing actual held-mark barrier checks this same baseline fence independently
of its exact Worker started-event UUID calibration; no observer or new product API
was introduced. The failure receipt keeps baseline/final values and claim context.

Native verification for this successor is still pending its scheduled window.
The changed 44-check fixture needs a new targeted run, mark-only helper probe and
selector probe. The other 17 old probes remain evidence for their original source
and unchanged subject bytes, rather than executions on the successor. No allowance,
assertion, skip, dependency pin or ownership boundary was relaxed.

Actual-process tests, build, committed probes, configured gates and BB validation
have NOT run on this preparation delta. The supervisor holds the heavy window for
another verification. Pure checks execute production control flow in memory on the
current Node; older supported Node versions use the build's emitted JavaScript.
They are not OS process-exit or lock-recovery evidence.

Evidence directory, relative to the owning thread's storage root:
`promptobus-migration/warden/stop-budget`.
Each `*-receipt.json` records exact argv, source SHA/status, diff hash, exit, duration
and canonical environment. Full streams remain beside the receipts.

| Pure command | Old source | Preparation result |
| --- | --- | --- |
| `node test/warden-cleanup-failure.test.mjs` | old345 twice: exit 1/1, 4/12 each | exit 0, 17/17, including primary, foreign-seat, coordinator and owner-exit checks |
| `node test/cursor-stop-deadline.test.mjs` | old Stop body: exit 1, 0/4 | exit 0, 5/5: no late dispatch, positive early fallback and zero-policy docs |
| `node test/live-cursor-cancel.test.mjs` | old caller: exit 1, 0/4 | exit 0, 4/4: positive/UNKNOWN and normal-to-abort single cleanup |
| `node test/live-mixed-cancel.test.mjs` | prior frozen suite: 13/13 | exit 0, 15/15: pre-await retention and disposal after confirmation |

Current counts are in `prep-final-*-pure.log` and subsequent freeze receipts, rather
than claimed from an earlier source. `git diff --check` and changed-file
`node --check` are light checks only. The first pure setup used an unavailable
TypeScript package API (0/0); another had a finally-fragment extraction error.
Those invalid setup results remain in raw logs. A new mixed test initially sampled
disposal before the abort promise settled (12/13, two repeated exits 1); its read is
now after await, while the separate pre-close held barrier remains asserted.
No red result was discarded as external or waived.

## Prepared actual regressions

1. `shared-warden-failure.test.mjs`: two actual task seats and an independent client;
   real departure-note path obstruction, an actual held journal lock during clear,
   and demand persistence refusal at actual Worker settlement. A held event accepts
   later demand before failure. Assert original fatal detail, owner PID/birth death,
   lock release, retained required work and one recovered generation with TCP delivery.
2. `live-cursor-cleanup.test.mjs`: early normal failure before native lift; delayed
   30 ms fresh native identity during SIGTERM; UNKNOWN abort and normal failure.
   Assert same native pane/owner proof before teardown, retained record/home/sandbox
   after child exit and subsequent exact-prefix sweep. Insurance is after verdict.
3. `live-mixed-timeout-retention.test.mjs`: hold an owned native Stop across the
   unchanged 30000 ms abort wait, both directly and after normal cleanup transfers
   to SIGTERM. Assert one Stop invocation, failed/pending outcome, child-exit and
   next-sweep retention; independent owned service exit is not native Stop proof.

Controlled old-source diagnostics use artifact-only copies of the test entry files
with literal paths to `old345-runtime`. They replace only copied core JavaScript or
live entry scripts before imports and preserve full selector patches/hash manifests.
The snapshot has old345 source SHA and the `final-tmux-sync-restored` build lineage.
They are diagnostic copies, not baseline package acceptance. The standard hygiene
filter remains unchanged; no environment selector is required or whitelisted.

The first actual command incorrectly passed an environment selector which hygiene
removed. Its receipts have `baselineRuntime: null` and establish current0911 only:
live Cursor 17/17 and mixed timeout retention 10/10, both exit 0. The core fixture
stopped after its first setup check because a private path helper was not exported;
its exact TypeError is retained in `frozen0911-old345-actual.log`. The fixture now uses
the documented task `waits/warden.exit.json` layout directly. No old-source failure
or core recovery pass is claimed from that invalid setup. The corrected fixtures
require a new committed run.

The artifact observer preserves copy manifests/instrumentation and selected native
JSONL before runner scratch removal. Do not print auth/environment or use NODE_DEBUG.

## Earlier evidence retained as precursor

- Historical approver a0b full run: exit 1, 201/202 files, mixed 13/15. Original
  scratch native ledger was removed. Historical delay cause is unknown; later PID
  absence does not establish Stop. This red is not waived by isolated passes.
- `DIAGNOSIS.json`: controlled synchronous Cursor tmux stall delays Codex entry
  until remaining 0, reproducing missing native request and both reviewer PIDs alive.
  It proves the stalled-preflight mechanism, not the historical full-run cause.
- 345 current normal/mixed pairs twice: exits 0/0, 7/7 + 17/17 each. Base8e original
  mixed stand twice: exits 0/0, 11/11 each. These are not final-delta gate evidence.
- 345 committed final-tmux-sync: wrapper 0, mutated 1 (8/17), restored 0 (17/17).
  Full streams, native JSONL and copy manifests are retained. Secondary mutated
  hang-case setup errors are not used as the native-shutdown proof. Six other
  prepared probes were held for this repair. Earlier 18b tmux/ps probe receipts
  remain precursor evidence as well.
- Root's `warden/zero-allowance/receipts.json`: base zero Stop succeeded at
  1365/1232 ms via synchronous overrun; current zero refused at 5/5 ms with record
  retained. The positive 2000 ms NOACK case took 2606 ms, removed the marker through
  late fallback but stayed unconfirmed with record retained. It is not a positive
  Stop pass or a hard 2s bound; the new dispatch guards require actual remeasurement.
- Nested installer advisory remains unclosed. No dependency fix or waiver is
  included here; the prior root diagnosis remains authoritative for that snapshot.

## Next exclusive verification window

Common environment: `TMPDIR=/private/tmp/pb4163-stop-tests-20261101`,
`npm_config_cache=/private/tmp/pb416-npm-cache-20261030`, PATH prefix
`/private/tmp/pb415-codex-0164-20261030/node_modules/.bin`.

On a clean committed SHA, sequentially:

1. `npm run build`.
2. Controlled old345 actual regressions and current actual regressions above,
   preserving full assertions, actual command JSONL and copied-runtime manifests.
3. Focused compatibility run including `shared-warden-lifecycle.test.mjs`,
   `shared-warden-service.test.mjs`, `promptobus-warden.test.mjs`,
   `cursor-stop-preflight.test.mjs`, both cancellation units, normal mixed cleanup,
   `exec-async-batch.test.mjs`, `tmpdir-sweep.test.mjs` and mixed stand. Any red requires
   two isolated current repeats and baseline evidence; fix scoped regressions.
4. Committed `npm run probe` for each changed boundary, with full mutated/restored
   streams and meaningful actual failure/recovery checks. Never overlap full suite
   and mutation probe. Regenerate stale patches against the new source.
5. Fresh independent full-range review `8e9bd6d438e30a4e18990b50b4d4e20129453e44..HEAD`.
6. `npx --no-install backslop gates --require-clean --base 8e9bd6d438e30a4e18990b50b4d4e20129453e44 --keep-going --json`.
   Configured gates are `npm test`, `npx --no-install backslop lint`, `npm run audit`,
   `npm run pins`, `npm run codex-schema`: preparation count 0/5, notRun 5,
   outOfScope 0.
7. Pinned `npm ci --prefix integrations/bb` only if needed, then
   `npm test --prefix integrations/bb`. Record actual advisory counts without waiver.

No native runtimes were started during this source-preparation stage. Final
readiness requires actual regressions, probes, fresh review, all configured gates,
BB evidence and scoped owned-process cleanup on the final committed source.
