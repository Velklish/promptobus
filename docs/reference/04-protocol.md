# Protocol

Protocol version: `1` (`src/index.ts` `PROTOCOL_VERSION`). Schemas: `schemas/v1/`.

## Addresses

```
orchestrator
worker:<slug>
reviewer:<slug>
approver:<slug>
```

`slug` is `[a-z0-9][a-z0-9-]*`. See `src/protocol.ts` `isAddress`. The
default routing rule keeps participant traffic with the orchestrator. One deliberate
exception opens direct worker↔approver traffic for a piece once a reviewer result is on record;
worker↔worker and every reviewer↔participant route remain refused. A direct sender must
already be registered in that task and its recorded session must match the calling
harness session. An explicit foreign-task argument never auto-registers a direct sender;
foreign registration remains available only for mail to `orchestrator`. Direct messages
bypass the orchestrator's unread mailbox but remain canonical in the task's
`messages/` journal and the addressed histories. The CLI and MCP surface pass one
recipient. The engine can fan out to many; that path is not exposed on
`promptobus_send`.

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

Participant settings and launch sidecars use `participantFileStem`: a worker keeps
`<slug>`, while reviewer and approver use `reviewer-<slug>` and
`approver-<slug>`. Worker names beginning with either reserved prefix are refused,
so two addresses cannot name the same sidecar.

Canonical messages, intent records and inbox or history references are hard links to one inode. The blob is also immutable: multiple artifact metadata records may name one content-addressed payload, and `prune` removes the task and its blobs together.

**Two locks, and they guard different things.** `.lock/` is the journal lock: the journal writers take it, and so does a piece sweep for the whole of its destructive stretch, worktree removal included. `.lock-blobs/` is the publication lock: a send that carries an artifact holds it while it writes the payload, names it and writes the metadata record, and a sweep holds it while it decides a payload is nobody's. A send with no artifact takes neither — the hot path of an ordinary message is untouched, and the measured cost on a send that does carry one is about half a millisecond, against a lock the journal holds across git.

The publication lock exists because the window between a payload and its record has nothing in it that names the payload: `stashBlob` finds an identical payload already there (`EEXIST` is dedup), and until the record lands a sweep reading the store sees a blob no record and no second link claims. Under the lock that window is not observable: a sweep either has not started or sees a finished publication. **`blobNamed` in `src/v1/artifacts.ts` is the one answer to "does anything still name this payload"** — a metadata record of the task, or a hard link beyond the blob file itself. `orphanBlobs` and the piece sweep both ask it, and both hand it one snapshot of the records rather than re-reading them per blob — that was measured at 400 artifacts, 3.8 s against 16 ms. What differs is WHEN the snapshot is read: the sweep reads it after the lock is in hand, so a record that landed while it waited is in the snapshot, and the only later change to the set is the sweep's own removals, which it tracks as it makes them. A listing reads it once because every blob should be judged against the same records.

**Publication holds the lock across an `await`, and that changes what a nesting licence may mean.** `withDirLock` lets a call nested inside this process's own critical section straight through, because a synchronous stretch cannot be interleaved and the nested call IS the same section. An `await` breaks that, so `withDirLockAsync` neither asks that licence nor hands it out: asynchronous holders of one lock path queue inside the process and each takes the directory in turn. A synchronous take arriving over a live asynchronous holder of the same process is refused outright rather than waited out, with its own code `lock-self-async` and not `lock-busy`: that one means "wait and retry", and here the wait is `sleepSync` and would block the very loop that has to release the lock. Waiting for a FOREIGN process differs by caller too: a synchronous take sits the hold out with `sleepSync`, because it has nothing else to do, while an asynchronous one awaits a timer — freezing the loop there would stop every other timer of the sender's own session for the length of a foreign hold, and a published asynchronous API has to behave as one. Two answers to that one question is the defect it replaced — the sweep read the link count, the engine read the records, and a payload could be nobody's to one of them while the other still held it. The full task tree and the safe deletion boundary for these paths are listed in [01-overview](01-overview.md) § Store home.

`promptobus sweep <address>` is the one cleanup that works inside a LIVE task, and it stays outside the engine for that reason: `engine.prune` refuses on an active task, and the moment one piece is accepted the task is active by definition. It removes the artifact metadata records of one sender, their `files/` entries and the blobs no surviving record names — never a canonical message, an inbox or history reference, a `waits/` sidecar, `health.json`, `supervisor.log` or `stalls.json`. The engine's own rule that blobs never leave one by one is not broken by it: a blob still leaves only when nothing names it, and a re-send of the same payload writes it again. A `files/` entry is addressed by the `filename` the record carries, which `sendSync` fills from the adapter's placement callback AFTER the digest, so a second send of one payload is recorded under the numbered name that actually landed. Which record an entry belongs to is then proven by the inode the two share, because a name without that proof could name a foreign file and an inode without the name cannot separate two entries of one deduplicated blob. The command is in [03-cli](03-cli.md) § Status, done, dismiss, history, prune.

## Fan-out

`send` validates the active task, sender, recipients, message type, body and routing policy before its first side effect. If an artifact is present, its name is checked first; the payload is then streamed or read once into a content-addressed blob and its metadata is validated and written before the message. The same checks apply to `sendSync`.

The message commit point is the exclusive creation of `intents/<id>.json` with `wx`. The intent is the complete canonical message, including recipients, and the sender writes `<id>.owner` beside it as a best-effort lease. The engine then links the intent to `messages/<id>.json`, links one reference to each recipient's inbox, and removes the intent and lease only after every reference exists. Each link is idempotent: `EEXIST` means the neighbouring pass already put that link. Hard links must stay on one filesystem; a lawful refusal is the typed `link-refused` result and leaves the intent open for recovery.

The engine returns `ActivationEvent` values after the fan-out is on disk. It does not wake participants itself: the supervisor and driver activate each recipient independently. A message can therefore be fully durable while activation is still pending.

## Recovery

`recoverTask` walks unclosed `.json` intents and repairs the missing canonical link or recipient references. It checks both `inbox/` and `history/` before adding a reference, so a message already read during a crash is not delivered a second time. A lease from the same host can identify a dead owner; an intent older than `INTENT_STALE_MS = 30_000` milliseconds is abandoned regardless of its lease.

The recovery result separates repaired fan-outs, activation events, unreadable records and failed materializations. A filesystem refusal such as `link-refused`, `dir-blocked` or `dir-occupied` leaves the intent for a later pass; if both the intent and canonical message have disappeared at materialization, the failure is `intent-lost` and is not retried. A malformed intent is isolated in `broken/messages/`, while a newer schema stays in place as `schema-version-unsupported`. Recovery continues through neighbouring intents and tasks; unrelated exceptions escape. Orphaned `.owner` files are swept after the same directory listing. The stable contract marker for `consumer-cli` lint is `intent-stale-ms: 30` (seconds).

## Validation

Runtime validation is implemented in `src/v1/validate.ts`, not by reading the JSON Schema files. The four models are `task`, `participant`, `message` and `artifact`. The validator checks the version first, rejects unfamiliar fields, then checks required fields and their grammars; a newer record returns `schema-version-unsupported`, while malformed data returns `schema-invalid`. `requireValid` turns the verdict into a typed `PromptobusError` before a write, so invalid task, participant, message or artifact data never enters the store.

The task and artifact records use schema version `1`, messages use protocol version `1`, participant ids and task ids are bounded ASCII names, message recipients are non-empty and unique, message types come from the frozen v1 list, and artifact metadata points only to a `blobs/<sha256>` path. A reader isolates malformed records when the operation allows it; it does not treat a newer record as corruption or silently migrate it.

**A rule about what may be WRITTEN does not belong here.** Record validation runs on every read — `readInbox`, `peekInbox` and `history` alike — and a schema-invalid record is moved to `broken/inbox`, so a constraint added to this list reaches backwards over every journal already on disk and stops delivering records an earlier release wrote lawfully. The `type=artifact` invariant is the worked example: it is enforced at the write, in the engine's `prepare` and at the tool boundary, and record validation stays silent about it, so a `type=artifact` record written before that refusal existed still reads as written. Tightening this list is a protocol-version change, not a patch.

## Fault injection

`EngineOptions.faults` accepts the test-only `FaultHook`; production does not supply it. Fan-out hooks run after durable `validate`, `blob`, `artifact`, `intent`, `canonical`, `ref` and `close` steps. The `read` hook marks the completed mailbox read. Read hooks run immediately before their named filesystem operation: `task-read`, `artifact-read`, `intent-read`, `inbox-read` (with `mode: "read"` for consuming reads, `mode: "peek"` for a foreign session's copy and `mode: "glance"` for warden glances) and `history-ref` — `artifact-read` fires before both the metadata read and the blob read of an artifact, and its `file` context says which; `intent-materialize` runs after intent validation and immediately before recovery materializes the message. The `mkdir` hook runs immediately before the directory create inside a fan-out link, for the canonical message and for each recipient reference; `target` is that directory and `to` is the link, and a throw there is classified as the directory refusal. A hook throw models a crash or filesystem refusal at that boundary so the suite can prove recovery without changing production behaviour. The warden's `supervisorRound` supplies its own `faults` option for the glance because `engine.glance` does not pass the engine hook.

## Engine

`openEngine({ root, policy })` or `openEngine({ home, policy })`. Exactly one of `root` / `home`. `policy` is required at open: a callback `{ allow: true } | { deny: true, reason }` per sender/recipient pair.

The engine does not wake anyone. It returns activation events. The warden and the driver wake the session.

Recovery is local to one intent. `RecoverResult` carries `repairs`, activation `events`, unreadable `broken` records, and `failed` fan-outs. A classified hard-link refusal adds `{ task, message, code: "link-refused", note }` to `failed`, leaves the intent for the next pass, and continues through the other intents and tasks. If materialization finds that both the intent and canon are gone, the same entry instead carries `code: "intent-lost"`: the message is permanently lost and will not be retried, but recovery still continues. Neither result aborts `openEngine({ recover: true })`. Other exceptions escape; recovery does not hide programmer errors or broaden the filesystem refusal taxonomy. A classified refusal while creating a recipient inbox directory uses the same `link-refused` classification, leaves the intent for retry, and does not abort open-time recovery. Mkdir errnos outside that hard-link list are classified only for this set: `EROFS` and `ENOSPC` are `dir-blocked` (delivered once the volume is writable again, or has space); `EEXIST` and `ENOTDIR` are `dir-occupied` (remove or move the stray file the error names); `ELOOP` is `dir-occupied` on the canonical directory and on a recipient directory (a symlink loop); on a recipient directory, `ENOENT` is `dir-occupied` as well (a stray or broken link). A `dir-blocked` refusal tells the sender the message is already committed and is delivered once the volume is writable again or has space, and a `dir-occupied` refusal says it is delivered once the path is clear; either way the sender must not resend. Any other mkdir errno escapes raw. A canonical-directory `ENOENT` stays raw so materialization can read it. The classified codes carry the errno and the path, leave the intent open, and do not abort open-time recovery. The no-argument `recover()` and `history()` operations cover readable tasks only; callers that need unreadable task journals pair them with `listTasks().broken`, while `RecoverResult.broken` remains for unreadable records inside a readable task.

The bus adapter opens with implicit recovery disabled, calls `recover()` once on the first access to a store in the process, and prints warnings for repaired fan-outs, unreadable records, retryable refusals, and permanent message loss before caching the engine. Both failure classes are therefore visible while `status`, `history`, `prune`, the warden, and MCP calls can still open the store. A later process retries a retained `link-refused`, `dir-blocked` or `dir-occupied` intent.

Every entry point selects `host.version` for the store home it will actually use. CLI dispatch selects it for the host-home commands (`spawn`, `review`, `status`, `done`, `dismiss`, `history`, and `prune`); the warden, guard, and MCP server select it after resolving their own home. An explicit `bus()` open without a reader version is a programming error, and engines are cached by store home and reader version, so an earlier access cannot leave a later reader using the wrong diagnosis vocabulary. A low-level adapter helper that reaches an unselected home warns once that it has an unversioned reader.

New orchestrator records carry the selected version when a task is created and when its mailbox is claimed; a sender automatically registered on a foreign task carries it too. If no version was selected, those writers warn with the home and record and leave `mechanismVersion` absent instead of inventing a release. If a participant record has unfamiliar fields and was written by a newer mechanism, the refusal is `schema-version-unsupported` and names both the writer and reader versions; prerelease and build suffixes are ignored for this newer-than comparison, while the original version strings remain in the diagnosis.

Mail is kept until read. Read is a rename from `inbox/` to `history/`. There is no exactly-once processing after that.

## Participant metadata

The v1 record's own fields are `id`, `role`, `harness`, `mode`, `sessionRef`, `capabilities`. Everything else the adapter writes about a participant lives in `metadata`, which the core does not look into, and the door into it is the accessors of `src/protocol.ts` — not a scatter of `p.metadata.<field>` reads.

`capabilities` is the driver's snapshot at lift time: `spawn`, `attach`, `activation`, `inspect` and `stop` are required; `denyTools`, `mcpDenyTools`, `systemPrompt`, `sessionList`, `enter` and `approverLift` are optional. `mcpDenyTools` and `approverLift` are additive contract extensions: a record from before either appeared remains readable without the field.

`metadata.routing` is one such field: the decision a lift made under `--strategy` ([03-cli](03-cli.md) § Model routing). It is written by `spawn` and `review` at the lift and read by `promptobus status` through `routingOf`, and it carries the strategy, the role, the tuple (`tupleId`, `harness`, `model`, `effort`), the chosen candidate's `score`, `strategySource` when the strategy came from a merged `defaults.strategy` rather than from a flag — absent when a person typed one, because there is nowhere else that value could have come from — the `snapshot` the pick was made on (`takenAt`, `ageSec`, `source`), the `windows` applicable to the chosen tuple with the `usedPercent` they had at that moment — the starting value the spend of a run is later read as a delta from, empty when the harness reported none — the `warnings` as codes, and the `constraints` with `applied`. An unrouted participant has no such field.

**The protocol version is not raised for it.** `metadata` is declared open in `schemas/v1/participant.schema.json`, so a record carrying a routing decision is readable by a mechanism of any version — which is exactly what that field exists for. A routed run is not migrated to and not migrated from: the decision describes the lift that happened, and a reader that does not know the field ignores it.

## Artifacts

An artifact is attached to a send. There is no separate upload command. **A message of type `artifact` always carries a file**: `send` refuses `type: "artifact"` with no `artifactPath`, and the refusal names that parameter. The refusal stands in `sendMessage` (`lib/store.js`), where both callers meet — the `promptobus_send` tool and the `send` command, which is built and covered but not registered ([03-cli](03-cli.md) § Send — built, not published) — so both are refused in the same words, and a later registration inherits the refusal rather than needing its own. The engine holds the same rule one layer down, so a message built past the adapter — through the public `send`/`sendSync` — cannot claim an attachment it does not carry: `prepare` refuses `type: "artifact"` that names no file at all, before the first side effect, and the refusal names both fields that can name one — `artifact` for a new attachment and `linkArtifact` for one already in the task. Linking satisfies the invariant, and the id is checked rather than trusted: `prepare` asks whether that artifact record is in **this** task and refuses `artifact-not-found` naming the id when it is not, so an id of the right shape pointing at nothing cannot write the very message this refusal exists against. **Presence is asked without reading the record** — `readArtifact` sets a corrupt one aside, and prevalidation leaves the task exactly as it found it; a broken record is classified by whoever reads it next, not by a send that may yet be refused by the routing policy. `finish` then writes that id into the record, and no second blob is stashed for bytes the task already holds. **The invariant is held at the WRITE and only there.** Record validation is deliberately unchanged: a reader isolates a schema-invalid record into `broken/inbox`, so binding the two fields in `validate` would reach backwards and stop delivering `type=artifact` records that earlier releases wrote without a file — records that exist in live journals. A record of that shape reads exactly as it was written, and no send can produce another. What the file holds is not judged here; the gate record and the handover record are checked against their own schemas, below. Blobs are content-addressed (`blobs/<sha256>`) and immutable inside one task. Missing metadata or a missing blob is `artifact-not-found`; metadata or a blob that exists but cannot be read with an errno other than `ENOENT` is `artifact-broken`, with the errno in `context`. The same `artifact-read` hook runs immediately before each metadata or blob read, and its `file` context distinguishes the two. Unparseable metadata and parsed metadata that violates the current schema are `schema-invalid` and are set aside in `broken/artifacts` when the move succeeds; metadata from a newer schema is `schema-version-unsupported` and stays in place. A blob whose digest or size differs from its metadata is `artifact-integrity`.

The name a sender passes is not always the name the artifact gets. **Leading dots are dropped** (`.gates-t2.json` lands as `gates-t2.json`): a hidden file is missed by an ordinary listing and by a `*.json` glob, and a reviewer handed that folder as its source of evidence reported a record that was there as absent — measured live, one name. A name of nothing but dots has no visible form left and is refused to the sender rather than landed hidden. Then `placeFile` takes the next free number on a taken stem (`report.md`, then `report-2.md`), and the numbering runs on the name that LANDS, so two sources differing only by a leading dot take two names instead of one silently shadowing the other; a name a mechanism file of the folder already holds is a collision like any other and is numbered the same way. The send reply prints the name that landed. A worker or approver that will name an artifact in its result sends that artifact first as its own message, reads the landed name from the immediate bus reply to its own `promptobus_send` call for that artifact — not from the path passed and not from the orchestrator — and, without ending the turn, puts that name in the result header. A reviewer cannot attach a file: file writes are disabled for it, so it cannot produce an artifact of its own — but it may **cite** a landed filename another participant sent, for example the author's gate record in its **Gate** line.

**A repeat of the same bytes is said out loud.** Blobs are content-addressed, so sending the same payload twice is lawful and costs nothing — two names, one inode. The send reply names the file that already holds those bytes (`the same content as report.md`) and, where the hard-link count is readable, how many names the payload now has. The line is assertive rather than a warning: the repeat is legitimate and often deliberate. What it answers is the one thing the sender cannot see — a participant who believed they had sent a corrected file got a reply indistinguishable from the reply to a new version, and the mechanism held the fact that would have said otherwise. The reading is of CONTENT: the same bytes under a different source name are still a repeat, and different bytes under the same source name are not.

**Hand-off order is machine-visible.** A claim is a **landed** filename that appears in the **Gate** or **Decide** line — dotted prose that matches no task artifact is not a claim. `send` refuses a landed name with no `artifact` message from **any** sender; citing another participant's landed file is lawful. The canonical result carries one metadata id in its `artifact` field — the first claimed landed name in header order that **this** sender also sent as an `artifact` message — using the frozen v1 field, not a new schema key. A citation with no own `artifact` message leaves the field unset. A result with no landed-name claim is lawful and is not judged. The loop guard adds a second case answer expectation cannot see: a gate-record artifact (`gates-<slug>.json`, with `numberedName` when the stem collides) sent since the last turn end with no `result` from the same sender in between holds the turn until the result goes out.

**An address's attachments are visible to its reviewer.** Every artifact an address sends into a task before `review` runs is listed in that address's review subject by landed name, type and send moment, taken from the journal rather than from a name pattern; one sent after that moment arrives with the next re-review ([03-cli](03-cli.md#review) § Review).


### The result hand-off

A result body is at most `RESULT_BODY_MAX` = 2400 characters and opens with four lines — **Done**, **Gate**, **Open**, **Decide**. The four lines are the whole form; what grew beside them is the evidence, and it travels as records rather than sentences — [the gate record](#the-gate-record) for what was run, which a worker and an approver both carry, and [the handover record](#the-handover-record) for why that run means anything, which is the **worker's alone**: an approver merges rather than writes code, and its own gate run is the integration gate. Everything past that bound travels as an artifact; a worker or approver sends it before the result so the header can name its landed filename. The number is measured rather than chosen: five real result bodies already written in this shape ran 1035, 1389, 1674, 2045 and 2100 characters, against a median of 5254 over 1151 free-text results, and a bound below what already worked would make the rule the defect. The worker, reviewer and approver preambles state it from one constant in `lib/handoff.js` — a number written twice drifts, and one role would then hold a different rule from another.

The rule lives in the preambles (`lib/spawn.js`, `lib/review.js` and `lib/approver.js`) and not only here, because a convention kept in a consumer's own rules is not delivered to a participant this package lifts.

**The Gate line is never omitted.** A gate that was not run says `not run, because …` with the reason; an omitted line reads as a green one. A reviewer writes that line on every report it sends — it runs nothing by [ADR-009](../adr/adr-009-reviewer-resolves-no-discrepancy.md) — which is why the line cannot be read as an escape hatch: it is the normal state of the role that runs no gates. An approver may **cite** another participant's landed artifact in the **Gate** line — the worker's gate record is the usual case — while its own overflow and gate record still bind only to its own send.

**The overflow rule is the worker's and the approver's, not the reviewer's.** A worker's and an approver's body is bounded and what does not fit is attached; a reviewer cannot attach anything — file writes are denied to it, and its own isolation text forbids publishing an artifact — so for a reviewer the bound covers the header alone and the findings follow it unbounded in the same body. A limit its holder cannot satisfy is not a strict rule but a wall, and one that would be broken silently on every long review.

### The gate record

A worker's or approver's gate claim travels as a record. `schemas/v1/gate-record.schema.json` is its shape: one entry per gate command carrying the `command` as executed, its `exit` code, the `counts` the runner printed under the runner's own names, the `tree` it ran on, whether that tree was `dirty`, the timestamp `at`, the address `by` (orchestrator, `worker:<slug>`, `reviewer:<slug>` or `approver:<slug>`), and a `tail` of the output. It is the payload of an artifact sent before the result as its own `artifact` message, and the ENGINE does not validate it: `validate` knows four models, and an artifact's bytes are opaque to it. `test/gate-record.test.mjs` asserts that `validate` goes on not knowing the name — a fifth file in `schemas/v1/` would otherwise read as a fifth engine model.

**`send` does check it, and refuses.** A document its own schema rejects looks like evidence and is not, and nobody opens the schema by hand in time: measured on one run, two of three attached records diverged from it and both authors learnt so from a reviewer reading the schema by eye. So a file whose name claims the stem — `gates-*.json`, and `handover-*.json` for [the handover record](#the-handover-record) — is read and checked against the published schema BEFORE its payload is written, and an invalid one is refused to the sender with the faults listed by field. A valid one passes through byte for byte; a file that claims neither stem is opaque bytes as before. The check is `lib/handoff.js`, over the same two name recognisers `review` resolves the attached records with — one door, not two.

The reader is `lib/schema.js` and it reads the schema FILE rather than a second copy of its rules, so the two cannot drift. The reference validator stays `ajv`, a devDependency: the package ships with no runtime dependencies, and that is a gate of its own suite. The pairing is the one `test/v1-validate.test.mjs` already makes for the four engine models — one fixture set, two verdicts, and they must agree on every document. A schema keyword the reader does not implement makes it throw rather than answer: a partial verdict handed over as a pass is the failure the check exists against.

**The mutation probe has no place in this schema, on purpose.** All three authors of that run needed one and expressed it three ways. A probe is not a gate command, and the record is one entry per command that ran: its home is `checks.mutationProbe` of [the handover record](#the-handover-record), which states the sha, the `file:line` broken, the mutated run's exit code, the counts and the names that reddened. A probe reported here as a `command` with an `exit` is schema-valid and says nothing the reviewer can check.

**The file is named, not described.** A worker requests the stem `gates-<worker slug>.json` (`GATE_RECORD_STEM` in `lib/handoff.js`); an approver requests `gates-<approver slug>.json`. Each sends the record before the result as its own `artifact` message, and reads the landed filename from the immediate bus reply to its own `promptobus_send` call — without ending the turn — for the Gate line. The bus may append a number to avoid a collision, and that returned name is the one the header quotes. `review` resolves every `gates-*.json` in the task files folder into absolute paths that go into both the first prompt and the re-review. Describing it as "a JSON file beside the diff" was not an address: that folder holds every worker's attachments and every review round's, and the result naming the right one reaches the orchestrator alone. Several records at once is a normal state — the `tree` field is what tells them apart, and none matching the reviewed sha means no record covers that tree. `numberedName` gives a repeat attachment the next number (`gates-x-2.json`), so a round does not overwrite the round before it.

`tree` is the HEAD commit sha, what `git rev-parse HEAD` prints. Not a git tree-object sha: the reviewer is handed `worktree HEAD <sha>` from the same call in its own prompt, so a tree-object sha would never compare equal and the comparison would be dead on the day it shipped. The pair is also what a runner already prints — `backslop gates` closes with `tree: <sha>, dirty`.

`tree` carries the full sha and nothing shorter. The comparison is an exact string match, so an abbreviation is a schema-valid record that could never match — measured before the bound was narrowed: `1966ace` passed the schema and is not equal to the `1966aceb…6de` the reviewer is handed.

**The comparison is the whole point, and so is its limit.** Same sha with `dirty: false` and `exit: 0` — the claim is evidence about **the commit at that sha, and about nothing else**. The review subject can hold more than that commit does: uncommitted tracked changes and untracked files both leave HEAD where it was, and `snapshot.clean` does not look at untracked paths at all, so a truthful record on a matching sha can still say nothing about part of what is under review. The reviewer is handed both facts in its subject line and is told to name the gap rather than let a matching sha stand for the whole subject. Another sha, a dirty tree, a non-zero exit, or no record at all — it is not evidence about that tree, the reviewer names which of the four it was, and the acceptance goes on with the gap named rather than being refused. Refusing outright was considered and rejected: a participant whose sandbox cannot run part of the set would then be unacceptable for ever, which is a wall and not a gate. What the record cannot do is prove the run happened — an author can write `exit: 0` beside the right sha having run nothing. Only a re-run on that sha by someone allowed to run catches that, and neither the record nor the reviewer is that someone.

**Size.** `tail` is bounded at `GATE_TAIL_MAX` = 2000 characters and `records` at 16 entries — at most 32 000 characters of output per document, against 350 480 that one green run of this repository's own chain prints. The bound is read off that run: a command's own summary sits in its last five lines (260 characters), and the longest red diagnosis measured — 22 lint findings with their summary — runs 2450 characters over its last twenty lines, of which 2000 carries the summary and the last sixteen findings. What the bound refuses to carry is a wall of repetitions, and that is the case where the log, not the record, is the right place.

### The handover record

The gate record says WHAT was run. It does not say why that run means anything, and the difference is not rhetoric: a suite that goes 244 to 242 to 246 reads as growth while a guarantee is gone, a mutation probe that stopped early prints `0/1` against a base of 26 and reads as catastrophe when it means interruption, and a red called environmental is a word until someone runs it on the base commit. None of those is a judgement — each is a command and an exit code, and the reviewer cannot run any of them ([ADR-009](../adr/adr-009-reviewer-resolves-no-discrepancy.md)). So they travel as a second record, sent the same way and read the same way.

`schemas/v1/handover-record.schema.json` is its shape: the branch `tree`, the `base` sha it was compared against, `at`, `by`, and `checks` — five of them, all required. **A check left out is not a check passed.** The only way past one is its own `notRun` branch carrying a reason, and a check honestly declared impossible passes: a form with no such branch is a form that rewards invented numbers, which is the defect [the gate record](#the-gate-record) was written against. The five are `verdictNames` (every name on base and not on the branch, each with why it went, or the explicit empty list — the check is defined by what went, and names that appeared need no defence), `mutationProbe` (the sha, the `file:line` broken, the mutated run's exit code, the counts, the names that reddened, and optionally the names it was made to redden), `treeState` (`git status --porcelain` before the probe and after the restore), `environmentalRed` (per claim: the assertion in full, the same verdict run on base, and the symmetric difference of the failure sets) and `gatesNotRun` (per command, its reason). `HANDOVER_CHECKS` in `lib/handoff.js` is the one list the preambles and the schema are both read against.

**Each check refuses its own defeat, in the schema and not in prose.** A removed verdict name with no `reason` is refused; a probe with `applied: false` is refused, because a mutation that never reached the code measured the unmutated tree; a probe with an empty `reddened` is refused, because a probe that turns nothing red found a hole in the tests rather than a fact to hand over; `treeState` takes the empty string at both ends and nothing else; a claim of "environmental" whose base run is green is refused, because red here and green on base is the author's own change; and a gate with no `because` is refused.

**Two exit codes meet at the probe and only one is recorded.** `npm run probe` in this repository leaves 0 on its single passing outcome — red with the mutation, green without it — and 1 on every other, so the probe tool's own code says pass or fail and nothing about the tree. What the record carries is `mutatedRunExit`, the code of the run made WITH the mutation in place, and it is at least 1: a run that reddened a verdict cannot have exited 0, and one that exited 0 saw nothing, which is a hole in the checks rather than a handover. The field is named rather than called `exit` because the two readings were measurably easy to swap.

**The probe names its target, and the door compares the two fields.** `reddened` says what went red; `expected` says what the mutation was made to redden, written down before the run. Without the second, a probe that reddened the wrong thing is indistinguishable from one that worked, and both live cases behind this were found by a person reading the content of the redness rather than its presence: a fixture on a relative path whose refusal came from `path.resolve` and never reached the gate under test — green with the gate removed — and a file that exited through `fail()` partway, producing no verdicts at all below that line. So `send` refuses a record whose `reddened` does not carry every name in `expected`, and the refusal prints both lists whole and then the names that never reddened. Both lists whole, because printing the missing part alone made a target that WAS hit read as a stray: with `expected` of two and one of them red, nothing left in the refusal said the red one had been declared. The diagnosis after the data differs by branch, because the two cases are different defects: nothing declared reddening is a probe that measured something other than the change, while SOME of it reddening means the mutation bit and either the rest of the targets do not cover the line it broke or they were the wrong ones to declare. The refusal is read by whoever comes to fix the probe, and one generalisation over both sends half of them looking the wrong way. **Subset, not equality:** more names in `reddened` is a wider net, not a wrong probe — a neighbouring verdict that also caught the mutation is evidence the mutation bit. The comparison sits in `recordRefusal` (`lib/handoff.js`) beside the schema pass and not inside the schema, because JSON Schema cannot compare two of its own fields and the reader in `lib/schema.js` implements a subset that deliberately cannot either; it is the same door both records already go through, so there is no second validator to drift from the first.

**The field is optional, and that is a compatibility guarantee rather than a claim.** Consumers hold records written by the previous version and read them mid-run, so a record that carries no `expected` passes exactly as it did — `test/promptobus-adapter.test.mjs` sends one through the door and `test/promptobus-spawn.test.mjs` sends another as part of an unrelated ordering check, which is what makes the compatibility something that turns red when broken. Nothing but the worker preamble then makes a new record carry the field; a schema-optional field with no prompt behind it is a field no record has.

**What it proves, and the two things it does not.** It catches the careless probe — the one that reddened something other than the target while the author did not look. It does not catch a dishonest one: the record is written after the run, so an author who copies `reddened` into `expected` produces a document this check accepts, the same limit the record already carries in "it cannot prove the run happened". And it does not catch the **aborted run**, which is the more expensive of the two failure modes: a file that dies partway can legitimately hold every declared name in `reddened` — they ran before the abort — while every verdict below that line silently produced nothing, and the record reads clean. Closing that one means counting executed verdicts against a base total in the runner, which belongs to the consumer's own suite and not to this schema; `verdicts.unaccounted` below is the nearest this record comes to it, and it rests on the author's arithmetic.

**The truncated run is caught by arithmetic the author does and states.** `verdicts.unaccounted` is `baseTotal − passed − reddened.length` and only `0` is accepted. JSON Schema cannot compare two of its own fields, so the choice was between a second validator and a stated remainder, and the remainder won for the reason PB-201 gave: there is no second validator to pair a schema with here. A non-zero remainder is not a failing probe to report — it is an interrupted one, run again or declared through `notRun`.

**The file is named, not described,** exactly as the gate record is: the stem is `handover-<worker slug>.json` (`HANDOVER_RECORD_STEM`), it goes as its own `artifact` message before the result, the landed name comes from the immediate bus reply to the worker's own `promptobus_send` call, and it is quoted in the **Gate** line after the gate record's — after, so the canonical result's `artifact` field still resolves to the gate record, which is the first claimed name in header order. `review` resolves every `handover-*.json` in the task files folder into absolute paths that reach both the first prompt and the re-review, and `tree` is what tells several of them apart.

**Two preambles of the three carry it, with different duties.** The worker attaches the record (`lib/spawn.js`); the reviewer reads it and names which checks are absent or `notRun` (`lib/review.js`), produces none of its own and does not repeat the checks by hand — it runs nothing. A `mutationProbe` carrying no `expected` is named there too, and it is the one PRESENT check that would otherwise pass in silence: the field is optional, so the cheapest way out of a refusal over it is to delete two lines and send again, and nothing else in the mechanism would hold a trace of that. An optional field is closed on the writing side by the preamble and on the reading side by this, or it is closed on neither. The **approver** carries no handover record at all (`lib/approver.js` is unchanged by it): it accepts and merges rather than writing the code, and its own gate run is the integration gate, so a missing handover record under an approver's hand-off is the expected state rather than a gap — the reviewer's prompt says so where the records are resolved. Two copies of one form is the standing risk in this package, and here the copies are deliberately not identical: one role makes the claim and the other reads it.

**The engine does not validate it,** for the same reason it does not validate the gate record: `validate` knows four models and an artifact's bytes are opaque to it. `test/handover-record.test.mjs` asserts the schema by ajv and asserts that `validate` goes on not knowing the name. **`send` checks its SHAPE** by the same door and the same reader the gate record goes through — one mechanism covers both stems, and a record the published schema rejects is refused rather than landed. It also refuses a record that **contradicts itself**, which is the one reading past shape it is allowed: `expected` against `reddened` is two fields of one document compared with each other, needing nothing outside it. What `send` does not do, and must not, is run or grade the checks themselves: **running them is the participant's, and judging them is the reviewer's.** A mechanism that ran a worker's tests to grade its handover would be a second runner with a second opinion about a tree it does not own.

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
