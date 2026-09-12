# Protocol

Protocol version: `1` (`src/index.ts` `PROTOCOL_VERSION`). Schemas: `schemas/v1/`.

## Addresses

```
orchestrator
worker:<slug>
reviewer:<slug>
```

`slug` is `[a-z0-9][a-z0-9-]*`. See `src/protocol.ts` `isAddress`. Workers do not send to workers. The CLI and MCP surface pass one recipient. The engine can fan out to many; that path is not exposed on `promptobus_send`.

## Message types

`task`, `status`, `question`, `answer`, `artifact`, `result`, `review` (`MESSAGE_TYPES`). The exported `MESSAGE_TYPES` and `MESSAGE_TYPES_V1` names are the same frozen readonly list: consumers can enumerate or copy it, but cannot add, remove, or replace a type and thereby change validation for the process.

Stored v1 messages carry `sender` and `recipients` as normalized participant IDs, the same values used for mailbox directories; they do not carry the caller's bus address spelling. For example, `worker:demo` is stored as `worker-demo`. Match a stored message by converting the address with the same normalization before comparing it.

`glanceInbox` only lists unread records; it does not consume them. A wait for a participant's verdict must therefore match both the normalized `sender` and `type`, rather than treating any `result` in the mailbox as that participant's message.

`artifactPath` on send is an absolute file path. The file is copied into the task store. The message stores the artifact name.

During a consuming mailbox read, a filesystem refusal while reading or moving one record is reported with the errno in `BrokenNote.code` and leaves its ref in place for a later consuming read. The same pass still returns every message it already moved to history. The unread ref keeps the mailbox unread, so the warden repeats its knock until the filesystem condition is lifted. `recover()` applies the same per-record rule to an unreadable intent: it reports the errno, leaves the intent in place, and continues through the other intents and tasks. Only a record that was read and found malformed is moved to `broken/`.

`glanceInbox` reports a filesystem refusal as a `BrokenNote` without moving the ref; the bus itself adds a postcard line naming the errno and ref, and the participant status line repeats the health mark while retries remain unbounded until a later glance reads it.

## Store layout

The engine receives either a workspace `root`, which resolves to `<root>/.promptobus`, or the store `home` itself. It never searches for a root or reads an environment variable. Under `tasks/<task-id>/`, `task.json` is the journal; `messages/` holds canonical messages; `intents/` holds open fan-outs; `inbox/<participant>/` is unread mail; `history/<participant>/` is mail that was read; `blobs/` holds immutable SHA-256 payloads; and `artifacts/` holds their metadata. A task journal lock is `.lock/`. An open intent has a neighbouring `<id>.owner` lease. `broken/inbox/<participant>/`, `broken/artifacts/`, and `broken/messages/` isolate malformed records without taking the rest of the task down. The adapter's `files/` directory is a human-facing sidecar, not an engine v1 path.

Canonical messages, intent records and inbox or history references are hard links to one inode. The blob is also immutable: multiple artifact metadata records may name one content-addressed payload, and `prune` removes the task and its blobs together. The full task tree and the safe deletion boundary for these paths are listed in [01-overview](01-overview.md) § Store home.

## Fan-out

`send` validates the active task, sender, recipients, message type, body and routing policy before its first side effect. If an artifact is present, its name is checked first; the payload is then streamed or read once into a content-addressed blob and its metadata is validated and written before the message. The same checks apply to `sendSync`.

The message commit point is the exclusive creation of `intents/<id>.json` with `wx`. The intent is the complete canonical message, including recipients, and the sender writes `<id>.owner` beside it as a best-effort lease. The engine then links the intent to `messages/<id>.json`, links one reference to each recipient's inbox, and removes the intent and lease only after every reference exists. Each link is idempotent: `EEXIST` means the neighbouring pass already put that link. Hard links must stay on one filesystem; a lawful refusal is the typed `link-refused` result and leaves the intent open for recovery.

The engine returns `ActivationEvent` values after the fan-out is on disk. It does not wake participants itself: the supervisor and driver activate each recipient independently. A message can therefore be fully durable while activation is still pending.

## Recovery

`recoverTask` walks unclosed `.json` intents and repairs the missing canonical link or recipient references. It checks both `inbox/` and `history/` before adding a reference, so a message already read during a crash is not delivered a second time. A lease from the same host can identify a dead owner; an intent older than `INTENT_STALE_MS = 30_000` milliseconds is abandoned regardless of its lease.

The recovery result separates repaired fan-outs, activation events, unreadable records and failed materializations. A filesystem refusal such as `link-refused` leaves the intent for a later pass; if both the intent and canonical message have disappeared at materialization, the failure is `intent-lost` and is not retried. A malformed intent is isolated in `broken/messages/`, while a newer schema stays in place as `schema-version-unsupported`. Recovery continues through neighbouring intents and tasks; unrelated exceptions escape. Orphaned `.owner` files are swept after the same directory listing. The stable contract marker for `consumer-cli` lint is `intent-stale-ms: 30` (seconds).

## Validation

Runtime validation is implemented in `src/v1/validate.ts`, not by reading the JSON Schema files. The four models are `task`, `participant`, `message` and `artifact`. The validator checks the version first, rejects unfamiliar fields, then checks required fields and their grammars; a newer record returns `schema-version-unsupported`, while malformed data returns `schema-invalid`. `requireValid` turns the verdict into a typed `PromptobusError` before a write, so invalid task, participant, message or artifact data never enters the store.

The task and artifact records use schema version `1`, messages use protocol version `1`, participant ids and task ids are bounded ASCII names, message recipients are non-empty and unique, message types come from the frozen v1 list, and artifact metadata points only to a `blobs/<sha256>` path. A reader isolates malformed records when the operation allows it; it does not treat a newer record as corruption or silently migrate it.

## Fault injection

`EngineOptions.faults` accepts the test-only `FaultHook`; production does not supply it. Fan-out hooks run after durable `validate`, `blob`, `artifact`, `intent`, `canonical`, `ref` and `close` steps. The `read` hook marks the completed mailbox read. Read hooks run immediately before their named filesystem operation: `task-read`, `artifact-read`, `intent-read`, `inbox-read` (with `mode: "read"` for consuming reads and `mode: "glance"` for warden glances) and `history-ref` — `artifact-read` fires before both the metadata read and the blob read of an artifact, and its `file` context says which; `intent-materialize` runs after intent validation and immediately before recovery materializes the message. A hook throw models a crash or filesystem refusal at that boundary so the suite can prove recovery without changing production behaviour. The warden's `supervisorRound` supplies its own `faults` option for the glance because `engine.glance` does not pass the engine hook.

## Engine

`openEngine({ root, policy })` or `openEngine({ home, policy })`. Exactly one of `root` / `home`. `policy` is required at open: a callback `{ allow: true } | { deny: true, reason }` per sender/recipient pair.

The engine does not wake anyone. It returns activation events. The warden and the driver wake the session.

Recovery is local to one intent. `RecoverResult` carries `repairs`, activation `events`, unreadable `broken` records, and `failed` fan-outs. A classified hard-link refusal adds `{ task, message, code: "link-refused", note }` to `failed`, leaves the intent for the next pass, and continues through the other intents and tasks. If materialization finds that both the intent and canon are gone, the same entry instead carries `code: "intent-lost"`: the message is permanently lost and will not be retried, but recovery still continues. Neither result aborts `openEngine({ recover: true })`. Other exceptions escape; recovery does not hide programmer errors or broaden the filesystem refusal taxonomy. A classified refusal while creating a recipient inbox directory uses the same `link-refused` classification, leaves the intent for retry, and does not abort open-time recovery. The no-argument `recover()` and `history()` operations cover readable tasks only; callers that need unreadable task journals pair them with `listTasks().broken`, while `RecoverResult.broken` remains for unreadable records inside a readable task.

The bus adapter opens with implicit recovery disabled, calls `recover()` once on the first access to a store in the process, and prints warnings for repaired fan-outs, unreadable records, retryable refusals, and permanent message loss before caching the engine. Both failure classes are therefore visible while `status`, `history`, `prune`, the warden, and MCP calls can still open the store. A later process retries only a retained `link-refused` intent.

Every entry point selects `host.version` for the store home it will actually use. CLI dispatch selects it for the host-home commands (`spawn`, `review`, `status`, `done`, `dismiss`, `history`, and `prune`); the warden, guard, and MCP server select it after resolving their own home. An explicit `bus()` open without a reader version is a programming error, and engines are cached by store home and reader version, so an earlier access cannot leave a later reader using the wrong diagnosis vocabulary. A low-level adapter helper that reaches an unselected home warns once that it has an unversioned reader.

New orchestrator records carry the selected version when a task is created and when its mailbox is claimed; a sender automatically registered on a foreign task carries it too. If no version was selected, those writers warn with the home and record and leave `mechanismVersion` absent instead of inventing a release. If a participant record has unfamiliar fields and was written by a newer mechanism, the refusal is `schema-version-unsupported` and names both the writer and reader versions; prerelease and build suffixes are ignored for this newer-than comparison, while the original version strings remain in the diagnosis.

Mail is kept until read. Read is a rename from `inbox/` to `history/`. There is no exactly-once processing after that.

## Participant metadata

The v1 record's own fields are `id`, `role`, `harness`, `mode`, `sessionRef`, `capabilities`. Everything else the adapter writes about a participant lives in `metadata`, which the core does not look into, and the door into it is the accessors of `src/protocol.ts` — not a scatter of `p.metadata.<field>` reads.

`capabilities` is the driver's snapshot at lift time: `spawn`, `attach`, `activation`, `inspect` and `stop` are required; `denyTools`, `mcpDenyTools`, `systemPrompt`, `sessionList` and `enter` are optional. `mcpDenyTools` is an additive contract extension: a record from before it appeared remains readable without the field. A newer participant journal that carries the field also carries its mechanism version; an older reader then reports `schema-version-unsupported` for the unknown key and asks for a new session, rather than treating the journal as damaged.

`metadata.routing` is one such field: the decision a lift made under `--strategy` ([03-cli](03-cli.md) § Model routing). It is written by `spawn` and `review` at the lift and read by `promptobus status` through `routingOf`, and it carries the strategy, the role, the tuple (`tupleId`, `harness`, `model`, `effort`), the chosen candidate's `score`, `strategySource` when the strategy came from a merged `defaults.strategy` rather than from a flag — absent when a person typed one, because there is nowhere else that value could have come from — the `snapshot` the pick was made on (`takenAt`, `ageSec`, `source`), the `windows` applicable to the chosen tuple with the `usedPercent` they had at that moment — the starting value the spend of a run is later read as a delta from, empty when the harness reported none — the `warnings` as codes, and the `constraints` with `applied`. An unrouted participant has no such field.

**The protocol version is not raised for it.** `metadata` is declared open in `schemas/v1/participant.schema.json`, so a record carrying a routing decision is readable by a mechanism of any version — which is exactly what that field exists for. A routed run is not migrated to and not migrated from: the decision describes the lift that happened, and a reader that does not know the field ignores it.

## Artifacts

An artifact is attached to a send. There is no separate upload command. Blobs are content-addressed (`blobs/<sha256>`) and immutable inside one task. Missing metadata or a missing blob is `artifact-not-found`; metadata or a blob that exists but cannot be read with an errno other than `ENOENT` is `artifact-broken`, with the errno in `context`. The same `artifact-read` hook runs immediately before each metadata or blob read, and its `file` context distinguishes the two. Unparseable metadata and parsed metadata that violates the current schema are `schema-invalid` and are set aside in `broken/artifacts` when the move succeeds; metadata from a newer schema is `schema-version-unsupported` and stays in place. A blob whose digest or size differs from its metadata is `artifact-integrity`.

## Claim

The orchestrator mailbox is owned by the session that opened the task. Another session gets a copy and a foreign-mailbox header. `promptobus_mailbox` with `claim: true` takes ownership when the previous session is gone. `src/protocol.ts` names the header constants.

### Messages: names, order and what a read marks

Source: `src/v1/messages.ts`.

Recoverable fan-out, mailbox, and history protocol v1.

**The fan-out design rests on a single inode.** The canonical message, the
fan-out intent, and every inbox reference are hard links to the same file,
and this is not a space saving — it is how atomicity is obtained where the
file system does not give it: two files cannot be created with one `rename`,
and "create the intent" is exactly one atomic `open(O_EXCL)`.

The order is:

1. Validate recipients and the routing policy — before the first side effect.
2. Create `intents/<id>.json` with the `wx` flag. **This is the commit
   point**: from here the message exists, and everything else is recoverable,
   because the intent IS the canonical message whole — the recipients sit
   in it too.
3. Link the canon: `link(intent → messages/<id>.json)`. Idempotent.
4. Link a reference into each recipient's inbox. Idempotent: `EEXIST` means
   "already there".
5. Drop the intent once every recipient has a reference.

After a crash, `recoverTask` writes what is missing — at engine open and on
demand. TWO places are checked THEN, inbox and history: a reference that is
not in inbox may already have been read, and recovery that looked only at
inbox would return the already-read message a second time. Activation runs
independently and AFTER the fan-out is on disk.

The FS requirement is inherited whole: hard links inside one volume. Their
absence is a lawful environment condition, and the answer is the typed
code `link-refused`, not a half-written record.

### The v1 store: what is written and in what order

Source: `src/v1/store.ts`.

Task journal v1: the task, participants, the owner, and an explicit claim.

Differences from the legacy store are not cosmetic, and both were named by a decision:

1. **The owner is a participant like any other.** It has `harness`, `mode`,
   `sessionRef`, and `capabilities`, and it is written when the task is
   created. v1 has no harness fallback at all: it was added to the registry
   exactly for the owner record that legacy `createTask` wrote without that field.
2. **Updating a participant is a field patch, not a whole-record replace.**
   In legacy `upsertParticipant` a second call that adds one field must put
   back THE SAME record — otherwise the first call's fields vanish in
   silence. There is no such invariant here: the patch touches the named
   fields and checks the schema after the merge.

### Validation of a v1 record

Source: `src/v1/validate.ts`.

Own protocol v1 validators: production does not read JSON Schemas at all.

The schemas live in `schemas/v1` and ship in the tarball for consumers; here
the same grammar is written by hand — so the package has no runtime
dependency. Drift between two descriptions of one contract is caught by a
parity test on a shared fixture set
([v1-validate.test.mjs](../../test/v1-validate.test.mjs)); edit one — edit
the other, or the red will come from there.

Check order inside a model is not accidental: the schema version comes
FIRST. A newer-version record is blocked by its own code without touching
the store, and there is no point parsing the rest of its fields — we do not
know the fields of that version.

### Artifacts: how a file becomes a message attachment

Source: `src/v1/artifacts.ts`.

Content-addressed v1 artifacts.

The payload is addressed by SHA-256 and deduplicated inside the task; the
file name lives separately, in metadata. The same payload under two names
yields two metadata records and one blob. The blob is immutable and is
deleted only with the task — `prune`.

The digest is computed as a STREAM, on the write pass: reading the file
twice would hash something other than what landed on disk — the source may
change between the two reads.

### The engine: the door every protocol write goes through

Source: `src/v1/engine.ts`.

Engine protocol v1: the only door into store v1.

The caller supplies the root, and the routing policy too, and both are
required at OPEN. The policy is here, not on the first send: an engine
without a "who may write to whom" rule is a bus whose rule will appear
someday, and until then everything goes through.

The engine is wired to the CLI through the mechanism door (the consumer
adapter): that opens it with the workspace root and the consumer routing
policy, and hands the models to consumers as they are.

### The v1 entry point

Source: `src/v1/index.ts`.

Protocol and store v1 — the production store since cutover
and its only surface: there is no longer a layer of former names over the
engine, and consumers call these models directly.

Names go out FLAT, from `../index.ts` (`export * from './v1/index.js'`): the
v1 surface is still from the main entry point; `./driver`, `./host`, and
`./hooks` go out separately. Raw store paths do not go out — the outside
sees protocol, not disk; the exception is declared by the engine itself
(`taskFile`, `inboxPath`, `historyPath`, `brokenPath`) and named there.

### Typed protocol errors

Source: `src/v1/errors.ts`.

Protocol v1 refusals: a typed code plus context.

Human wording is the adapter's job, and that is not style: the package must
compile and be tested without the CLI, and user output stays in the CLI
entirely. So what goes out is a `code` from the list below and `context`
with the facts of the refusal; `message` inside the exception is left for
debugging — a consumer has no need to read it, and must branch on the code.

### The v1 record shapes

Source: `src/v1/model.ts`.

Protocol v1 models and the grammar of their fields.

Forms and regular expressions only — no disk, no policy. `TASK_ID_RE` lives in
[protocol.ts](../../src/protocol.ts), so the CLI gate and store read one object;
`schemas/v1/{task,message}.schema.json` carry the same `{0,127}`, pinned by the
exact-bound fixtures in [v1-validate.test.mjs](../../test/v1-validate.test.mjs).

### Where a v1 store puts things on disk

Source: `src/v1/layout.ts`.

On-disk layout of store v1.

The caller supplies the root: the package does not search the workspace and
does not read the environment — that is the adapter's business. Path joining
only, no disk access.

### Addresses: the spelling, the transliteration and the refusals

Source: `src/protocol.ts`.

Bus vocabulary: message types, addresses, task identity, and the foreign-mailbox
gate wording. No disk, no store — only the grammar and the strings everyone prints.

The home is here, not in either store, because the package has two: production v1
(`store.ts`) and legacy, kept so migration can still read
([legacy-store.ts](../../src/legacy-store.ts)). A value that lived in one of them would be
imported by the other across a version boundary — and they would drift in silence.

### The bus contract constants

Source: `lib/contract.js`.

Bus-contract values cited in prose: CLI help, the reference, the guide, and the
orchestration skill. The server-name literal lives in the compiled package contract
and is re-exported here; the remaining adapter constants have their only home here.

**Only harness-neutral lives here**. Effort levels, permission modes, binary versions,
and the list of tools to deny moved to the driver ([driver-claude.js](../../lib/driver-claude.js)):
that is ONE harness's dictionary, and the second driver has its own — a shared home
would mean the bus knows Claude Code values by heart. Contract citations in the docs
still stand on them: `lint` takes the value from the new home, and the
`<!-- contract:… -->` keys did not change.

Its one dependency is the compiled, dependency-free contract source — the same
lib→dist boundary used by the host adapters. Command help reads this module before
any work, so it still pulls no repository resolver. Message types were removed from
here at the same price: their home is the package, and importing them here would drag
the store along.

`lint` takes them from here too, checking prose against code: a documentation block
marked with a contract key must list exactly these values.

### When an unclosed intent counts as abandoned

Source: `src/v1/messages.ts`.

Whether an unclosed intent is abandoned — that is, whether recovery may
touch it.

A neighbour's live fan-out must not be picked up: recovery materializes the
canon and drops the intent, and the owner at that moment is walking to its
own `link` — and gets `ENOENT` on a delivered message, a refusal on success.

Branches, in this order:
1. age is at least `INTENT_STALE_MS` — abandoned regardless of the lease
   (the upper bound). Age is computed from local clocks by `mtime`, and on
   a shared mount `mtime` is set by the owner's machine: the branch admits
   that the home has one clock. Drifted clocks move the threshold itself,
   but not the decision about a live owner — that is guarded by branch 2
   by comparing the host;
2. there is no lease, or it is from a foreign machine — owner liveness is
   unknown, wait for the threshold;
3. the pid is ours — abandoned. The life of an intent inside a process is
   ONE synchronous block: `commitIntent` and `completeFanout` are
   synchronous whole, and every `await` of `send` stands before the commit
   point, so our own pid on an intent means "a previous process with the
   same number", not "it is being written right now". If an await appears
   between creating the intent and dropping it, the branch becomes wrong,
   and the crash checks in `v1-engine.test.mjs` go red on that: they crash
   the send at the seam and recover in THE SAME process;
4. otherwise owner pid liveness decides.

### Writing a message: the order the names are taken in

Source: `src/v1/messages.ts`.

Lease: who is writing this fan-out right now. Laid down NEXT TO the intent,
as a separate file, not as a field on the record: the intent and the canon
are one inode, and the field would travel into every recipient's inbox and
into history, and a reader of the former version would reject such a
message by schema (`additionalProperties: false`) and take it to `broken`.
A separate file is invisible to former readers by construction — they walk
the intents directory by the `.json` mask.

A write refusal does not cancel the send: the commit point is the intent,
and the lease only speeds up recovery; without it the intent is treated as
abandoned by age.

The `w` flag, not `wx`: exclusivity is already won by the `wx` creation of
the intent itself, and `wx` here would mean "an orphaned `<id>.owner` under
the same name stays foreign" — a fresh intent would carry foreign pid and
host and would either be declared abandoned at once or wait the threshold
in vain. That names may repeat is something the code already counts on:
`commitIntent` reassembles the id on `EEXIST` up to 16 times.

### Artifacts: collisions and what a name promises

Source: `src/v1/artifacts.ts`.

The same, synchronously, from a file. Made for an adapter whose send path
is synchronous whole (`sendSync` below): the bus MCP server answers
`tools/call` in one synchronous pass, and a promise in the middle of it
would rewrite the tool dispatcher for one artifact.

The streaming-branch invariant is held, not loosened: the file is read
ONCE, and the digest is computed over the very bytes that will land in the
blob. The cost is the file size in memory; bus artifacts are a diff and a
contract, not a disk image.

**The "one pass" property is structural, and no gate covers it.** It holds
because there is no window between read and write in the code at all:
one `readFileSync`, the digest is computed over that same buffer, and that
same buffer is written. There is nowhere to swap the payload "between two
reads", and a two-pass-edit probe paints nothing — so there is no check
for this property, not a green one. What is actually checked: the record
digest matches the blob payload, and a read refuses `artifact-integrity`
on a mismatch.

### Same-session identity, and the prefix fallback

Source: `src/protocol.ts`.

Whether these are the same session identifier — a FALLBACK rule, for records
without a full id. The check there is prefix-based: the harness names one
session two ways — the full identifier is a uuid, and the short `id` that
lift parsed from `--bg` output is the first eight hex of the same uuid
(measured: `id: "e8c5be23"` against
`sessionId: "e8c5be23-dfef-4d20-bd96-e2a40a366b97"`).

**That premise is not our contract, and a gate must not be built on it**
(review remark). If the spellings drifted on the next build, the check would
call every session foreign, in silence. So the primary rule became equality
of full ids (`foreignSessionOf` below), and the prefix stayed where there is
no full id to take: previous-release records and lifts where `agents --json`
did not parse and the id came from free-text output.

Case is folded: harness hex is lower, but that rule is not ours. Empty on
both sides is not a match, it is unknown: the caller decides.

### Reading a mailbox: what a read marks and what it does not

Source: `src/v1/messages.ts`.

Threshold after which an unclosed intent is treated as abandoned regardless
of the lease.

It is also the upper bound of the lease: a pid the OS reused for a foreign
process would otherwise lock a foreign intent forever, and the undelivered
would sit forever. The slack is taken from the cost of one send: measured
2026-09-02, 500 sends in a row — 1.4 ms CPU per send at a median of 1.3 ms;
under load (load average 38–44) the median is the same, and the tail is
stretched by the scheduler: p99 35–67 ms, the longest of one and a half
thousand — 141 ms. The threshold is two hundred times that, and a live
intent never lives longer than a send at all: from `wx` creation to drop
it is a synchronous block.

Exported for a contract quote: the reference names the threshold in
seconds, and `lint` checks that number against this constant through
`dist`; there are no other consumers outside.
