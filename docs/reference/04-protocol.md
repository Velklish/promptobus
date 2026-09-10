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

`EngineOptions.faults` accepts the test-only `FaultHook`; production does not supply it. Fan-out hooks run after durable `validate`, `blob`, `artifact`, `intent`, `canonical`, `ref` and `close` steps. The `read` hook marks the completed mailbox read. Read hooks run immediately before their named filesystem operation: `task-read`, `artifact-read`, `intent-read`, `inbox-read` and `history-ref` — `artifact-read` fires before both the metadata read and the blob read of an artifact, and its `file` context says which; `intent-materialize` runs after intent validation and immediately before recovery materializes the message. A hook throw models a crash or filesystem refusal at that boundary so the suite can prove recovery without changing production behaviour.

## Engine

`openEngine({ root, policy })` or `openEngine({ home, policy })`. Exactly one of `root` / `home`. `policy` is required at open: a callback `{ allow: true } | { deny: true, reason }` per sender/recipient pair.

The engine does not wake anyone. It returns activation events. The warden and the driver wake the session.

Recovery is local to one intent. `RecoverResult` carries `repairs`, activation `events`, unreadable `broken` records, and `failed` fan-outs. A classified hard-link refusal adds `{ task, message, code: "link-refused", note }` to `failed`, leaves the intent for the next pass, and continues through the other intents and tasks. If materialization finds that both the intent and canon are gone, the same entry instead carries `code: "intent-lost"`: the message is permanently lost and will not be retried, but recovery still continues. Neither result aborts `openEngine({ recover: true })`. Other exceptions escape; recovery does not hide programmer errors or broaden the filesystem refusal taxonomy. A classified refusal while creating a recipient inbox directory uses the same `link-refused` classification, leaves the intent for retry, and does not abort open-time recovery.

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
