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

**Whether a type asks its recipient for an answer is part of the protocol, not a habit.** The table is `ANSWER_EXPECTED` in `lib/answers.js`, and it is one list with two readers: the loop guard holds a turn that ends owing an answer, and `promptobus status` prints `UNANSWERED`.

| type | answer expected | what the answer is |
|---|---|---|
| `task` | yes | the hand-over of work: a `status` on taking it, a `result` when it is done |
| `question` | yes | an `answer` |
| `review` | yes | a `result` with the notes closed |
| `result` | yes | the hand-over that asks for acceptance: a `review` with notes, or silence once accepted |
| `status` | **no** | nothing. A status is one-way — the sender must not end its turn waiting for an acknowledgement |
| `answer` | **no** | nothing; it is itself the answer to a `question` |
| `artifact` | **no** | nothing; the file is named in the message that carries it |

Two limits on reading that table. It says what a TYPE asks for, not what any particular participant owes: the orchestrator is outside it by decision, and the edge that leaves is named in [03-cli.md](03-cli.md) § Guard and warden. And "no answer expected" never means "no need to read": the warden escalates an unread mailbox to `SILENT` for every address including the orchestrator, and that is unchanged.

Stored v1 messages carry `sender` and `recipients` as normalized participant IDs, the same values used for mailbox directories; they do not carry the caller's bus address spelling. For example, `worker:demo` is stored as `worker-demo`. Match a stored message by converting the address with the same normalization before comparing it.

`glanceInbox` only lists unread records; it does not consume them. A wait for a participant's verdict must therefore match both the normalized `sender` and `type`, rather than treating any `result` in the mailbox as that participant's message.

A `result` body opens with a fixed four-line header — what was done, the gate command with its exit code, what is left open, what needs a decision — inside a bound of 2400 characters, and everything past it is attached as an artifact the header names; the shape, the numbers and the gate record that goes with it are in § Artifacts, and the rule itself is stated in the participant preambles rather than in a consumer's rules.

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

The name a sender passes is not always the name the artifact gets: `placeFile` takes the next free number on a taken stem (`report.md`, then `report-2.md`), and the send reply prints the name that landed. A message body written before the send can therefore name a file that does not exist — quote the name from the reply, not from the path you passed.

### The result hand-off

A result body is at most `RESULT_BODY_MAX` = 2400 characters and opens with four lines — **Done**, **Gate**, **Open**, **Decide**. Everything past that bound travels as the artifact the header names. The number is measured rather than chosen: five real result bodies already written in this shape ran 1035, 1389, 1674, 2045 and 2100 characters, against a median of 5254 over 1151 free-text results, and a bound below what already worked would make the rule the defect. Both preambles state it from one constant in `lib/handoff.js` — a number written twice drifts, and the reviewer would then hold a different rule from the worker it reviews.

The rule lives in the preambles (`lib/spawn.js`, `lib/review.js`) and not only here, because a convention kept in a consumer's own rules is not delivered to a participant this package lifts.

**The Gate line is never omitted.** A gate that was not run says `not run, because …` with the reason; an omitted line reads as a green one. A reviewer writes that line on every report it sends — it runs nothing by [ADR-009](../adr/adr-009-reviewer-resolves-no-discrepancy.md) — which is why the line cannot be read as an escape hatch: it is the normal state of one of the two roles.

**The overflow rule is the worker's, not the reviewer's.** A worker's body is bounded and what does not fit is attached; a reviewer cannot attach anything — file writes are denied to it, and its own isolation text forbids publishing an artifact — so for a reviewer the bound covers the header alone and the findings follow it unbounded in the same body. A limit its holder cannot satisfy is not a strict rule but a wall, and one that would be broken silently on every long review.

### The gate record

A worker's gate claim travels as a record. `schemas/v1/gate-record.schema.json` is its shape: one entry per gate command carrying the `command` as executed, its `exit` code, the `counts` the runner printed under the runner's own names, the `tree` it ran on, whether that tree was `dirty`, the timestamp `at`, the address `by`, and a `tail` of the output. It is the payload of an artifact sent before the result as its own `artifact` message, and the engine does not validate it: `validate` knows four models, and an artifact's bytes are opaque to it. There is no second validator to pair the schema with, and `test/gate-record.test.mjs` asserts that `validate` goes on not knowing the name — a fifth file in `schemas/v1/` would otherwise read as a fifth engine model.

**The file is named, not described.** A worker attaches it as `gates-<worker slug>.json` (`GATE_RECORD_STEM` in `lib/handoff.js`), and `review` resolves every `gates-*.json` in the task files folder into absolute paths that go into both the first prompt and the re-review. Describing it as "a JSON file beside the diff" was not an address: that folder holds every worker's attachments and every review round's, and the result naming the right one reaches the orchestrator alone. Several records at once is a normal state — the `tree` field is what tells them apart, and none matching the reviewed sha means no record covers that tree. `numberedName` gives a repeat attachment the next number (`gates-x-2.json`), so a round does not overwrite the round before it.

`tree` is the HEAD commit sha, what `git rev-parse HEAD` prints. Not a git tree-object sha: the reviewer is handed `worktree HEAD <sha>` from the same call in its own prompt, so a tree-object sha would never compare equal and the comparison would be dead on the day it shipped. The pair is also what a runner already prints — `backslop gates` closes with `tree: <sha>, dirty`.

`tree` carries the full sha and nothing shorter. The comparison is an exact string match, so an abbreviation is a schema-valid record that could never match — measured before the bound was narrowed: `1966ace` passed the schema and is not equal to the `1966aceb…6de` the reviewer is handed.

**The comparison is the whole point, and so is its limit.** Same sha with `dirty: false` and `exit: 0` — the claim is evidence about **the commit at that sha, and about nothing else**. The review subject can hold more than that commit does: uncommitted tracked changes and untracked files both leave HEAD where it was, and `snapshot.clean` does not look at untracked paths at all, so a truthful record on a matching sha can still say nothing about part of what is under review. The reviewer is handed both facts in its subject line and is told to name the gap rather than let a matching sha stand for the whole subject. Another sha, a dirty tree, a non-zero exit, or no record at all — it is not evidence about that tree, the reviewer names which of the four it was, and the acceptance goes on with the gap named rather than being refused. Refusing outright was considered and rejected: a participant whose sandbox cannot run part of the set would then be unacceptable for ever, which is a wall and not a gate. What the record cannot do is prove the run happened — an author can write `exit: 0` beside the right sha having run nothing. Only a re-run on that sha by someone allowed to run catches that, and neither the record nor the reviewer is that someone.

**Size.** `tail` is bounded at `GATE_TAIL_MAX` = 2000 characters and `records` at 16 entries — at most 32 000 characters of output per document, against 350 480 that one green run of this repository's own chain prints. The bound is read off that run: a command's own summary sits in its last five lines (260 characters), and the longest red diagnosis measured — 22 lint findings with their summary — runs 2450 characters over its last twenty lines, of which 2000 carries the summary and the last sixteen findings. What the bound refuses to carry is a wall of repetitions, and that is the case where the log, not the record, is the right place.

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
entirely. So what goes out is a `code` from the published list and `context`
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

### `abandonedIntent` — whether an unclosed intent is abandoned — that is, whether recovery may

Source: `src/v1/messages.ts`, `abandonedIntent`.

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

### `leaseIntent` — lease: who is writing this fan-out right now

Source: `src/v1/messages.ts`, `leaseIntent`.

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

### `stashBlobSync` — the same, synchronously, from a file

Source: `src/v1/artifacts.ts`, `stashBlobSync`.

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

### `sameSession` — whether these are the same session identifier — a FALLBACK rule, for records

Source: `src/protocol.ts`, `sameSession`.

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

### `INTENT_STALE_MS` — threshold after which an unclosed intent is treated as abandoned regardless

Source: `src/v1/messages.ts`, `INTENT_STALE_MS`.

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
