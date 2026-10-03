# Protocol

Protocol version: `1` (`src/index.ts` `PROTOCOL_VERSION`). Schemas: `schemas/v1/`.

## Addresses

```
orchestrator
worker:<slug>
reviewer:<slug>
approver:<slug>
```

`slug` is `[a-z0-9][a-z0-9-]*`. See `src/protocol.ts` `isAddress`. The list above is
the orchestrator and the shipped pipeline of the role registry ([§ The role
registry](#the-role-registry)). The grammar admits the slugless `orchestrator`, `reporter`
and `user` and `<name>:<slug>` under any other step-shaped name; which of those names exist
is the registry's answer, asked where a participant is written or addressed. The governance
addresses `teamlead:<slug>`, `root:<slug>`, `peer:<slug>`, `reporter` and `user` are known to it. Teamlead
lifts and `link` register their addresses; `ask` registers `user` in the addressed task on
first use, and `report` registers `reporter` in a root task. Once registered, their routes are the closed table
below. `addrDir` is injective only over admitted addresses —
`reviewer-two:x` and `reviewer:two-x` both give `reviewer-two-x` — so injectivity lives in the registry: `withSteps`
refuses an overlapping declaration and the registry doors refuse an unknown role. The
default routing rule keeps step traffic with the orchestrator. The declared `edits-tree`
owner and the one `writes-main-tree` step of a piece may write directly after a reviewer
result is on record; `reads-diff` and other step pairs stay on the orchestrator route.

| Sender | Recipient | Types | Decision |
|---|---|---|---|
| `orchestrator` | any participant of its task | all seven | unchanged |
| any participant | `orchestrator` of its task | all seven | unchanged |
| declared owner | declared `writes-main-tree` step of its task | all seven | the one direct step pair |
| `teamlead:a` | `teamlead:b` of the same root task | `question`, `answer`, `status`, `artifact` | small matters stay between siblings; a change of logic or requirements goes to the root orchestrator |
| `orchestrator` of a root task | `teamlead:<slug>` whose child task is active | all seven | delivery enters that child's `orchestrator` mailbox as `root:<root slug>` |
| `orchestrator` of a child task | `root:<root slug>` of that task | all seven | delivery enters the root's `orchestrator` mailbox as the bound `teamlead:<slug>` |
| `orchestrator` | `peer:<slug>` | `question`, `answer`, `status`, `artifact` | peers ask, never assign; delivery enters the other root's orchestrator mailbox as its peer sender |
| `user` | `orchestrator` of a root or child task | `question` | the person asks that task's orchestrator; `teamlead:<slug>` selects its child task |
| `orchestrator` of a root or child task | `user` | `answer`, `status` | the answer and progress lines in the same task |
| `reporter` | nobody | none | the reporter reads |

**A teamlead has one mailbox: the `orchestrator` mailbox of its child task.** Its bus entry
reads that mailbox and no other, so the two teamlead rows take priority over the generic
`orchestrator` rows. A root orchestrator's send to `teamlead:<slug>` whose record names an
active child (`childTask`, with that child's `parent` naming the root) is written into the
child as `root:<root slug> → orchestrator`; the root journal does not carry it. The message
records the root id as `originTask`, its artifact belongs to the child, the child's warden
knocks the teamlead as for any other mail of that mailbox — once for new unread mail, never
for mail already read — and the reply names the child as the task it landed in and the
teamlead address it went `via`. A teamlead whose child is closed keeps
root mail in the root task as before. The child's `root:<root slug>` record stands for the
root orchestrator: `spawn --teamlead` writes it after the child link, and a delivery or a
drain writes it into a child lifted earlier. It carries `rootTask` and no session, so no
session sends as it; the routing policy lets it talk to the child's `orchestrator` only. A
send from the child's `orchestrator` to it is written into the root as
`teamlead:<slug> → orchestrator` while the root record and the child owner are bound to one
session, the same proof the sibling route asks. The address carries the root task's
`adapter.slug`, or the slugified root id when there is none. It is slugged, not a bare
`root`, because a reader that predates the address still runs during an upgrade — a
participant's MCP server, a warden — and that grammar admits only `orchestrator`, `reporter`
and `user` bare. Measured with the 0.22.0 CLI on a child journal carrying each form: a bare
`root` record printed `MAILBOX UNREAD: the record address is invalid` in `status`, a
`root:root` record printed an ordinary `root:root · unread 0` line, and the MCP `task` and
`mailbox` calls and a warden round completed on both. Sibling traffic is unchanged:
`teamlead:a → teamlead:b` still lands in the root task's `teamlead-b` mailbox, which a Claude
Code teamlead's tools do not read. The digest pairs a question in one of the two journals
with its answer in the other ([03-cli § Digest](03-cli.md#digest)), and a teamlead's read of
its mailbox first moves root mail an earlier version left in the root
([03-cli § Spawn](03-cli.md#spawn)).

The specific `peer:<slug>` rule takes priority over the generic participant-to-orchestrator row:
peer-to-orchestrator sends also need a reciprocal link and use only the four types in the peer row.
The `user` and `reporter` rows take the same priority over generic vertical traffic.
A teamlead cannot grant the reporter a send route. The reporter-only MCP `promptobus_ask`
uses a proven reporter session binding, then writes a `question` as `user`
to its root orchestrator; `promptobus_digest` and `promptobus_status` use the same proof for
reads of that root tree. The terminal `ask` command still refuses every
participant identity, including the reporter, and `promptobus_send` still
refuses a reporter sender at the routing policy.
A teamlead pair is a sibling pair only when both records in the root point to child tasks whose `parent`
names that root and whose owner sessions match the teamlead bindings. A peer route needs a
`peerTask` link in both roots, with each peer record bound to the other root's owner session.
`link` writes those records under the two task locks in task-id order; the route stays
closed if a crash leaves only one record. `unlink` removes both records without changing
the messages already in either journal. An orchestrator send to its `peer:<slug>` address
is delivered to the other root's `orchestrator` mailbox with the sender recorded as
`peer:<source-slug>`. Its artifact belongs to the destination task, and that task's
warden wakes its owner. A direct send into the other root as its bound peer address uses
the same reciprocal-link rule. Each routed peer message records `originTask`, the source
root's id, beside `task`, the destination root's id. The field is optional in the v1
message schema so journals written before it remain readable; new peer sends always write it.
It persists through unlink and later links to roots with the same slug. See
[03-cli § Link](03-cli.md#link).

Other pairs are refused with the root orchestrator as the route. A direct sender must
already be registered in that task and its recorded binding must positively hold the
calling session, including an exact session-record pointer before or after the harness id
is written. Direct messages bypass the orchestrator's unread mailbox but remain canonical in the task's
`messages/` journal and the addressed histories. The CLI and MCP surface pass one
recipient. The engine can fan out to many; that path is not exposed on
`promptobus_send`.

**A session holds one address per task, and the sender is resolved per task.** Both doors —
`promptobus send` and `promptobus_send` — ask `senderFor` (`lib/store.js`): among the
participants of the task the call names, the sender is the one whose record the calling
session PROVABLY holds (`holdsSession`, `src/protocol.ts`). The `orchestrator` record is held
by its recorded owner; any other record by the `sessionId` its lift wrote, by its short
`session` as a prefix when no full id is on record, or by its exact `sessionRecord` pointer.
The pointer is accepted only after the driver record proves the same physical home and exact
task and address. Claude Code receives its chosen `--session-id` UUID before launch; Codex and
Cursor bind their record pointers before launch and keep them when the harness id arrives.
The MCP resolver uses the pointer until the driver record id matches the participant's
full or short id binding, then uses that id for a session's other task records.
A record with none of those bindings may be read and is never sent as. `foreignSessionOf`
stays the reading rule — it answers `null` for an
unbound record, which is right for "is this proved foreign" and wrong for "is this mine".
`PROMPTOBUS_ROLE` is a hint. When it names a record the session holds, it picks that record
on any task — it grants nothing, it chooses among what is already proven. On a call to
`PROMPTOBUS_TASK`, or when no task is declared, it also binds: the sender must be the declared
address, and a disagreement is refused naming both; on any other task a hint the session does
not hold is ignored and the record alone decides. Nothing falls back to `orchestrator`,
a task with no recorded owner has no provable orchestrator, and a session with no record in a
task cannot send there — `sendMessage` refuses a sender the task does not list, and no message
registers one ([ADR-019](../adr/adr-019-session-address-per-task-lands.md)).

## Message types

`task`, `status`, `question`, `answer`, `artifact`, `result`, `review` (`MESSAGE_TYPES`). The exported `MESSAGE_TYPES` and `MESSAGE_TYPES_V1` names are the same frozen readonly list: consumers can enumerate or copy it, but cannot add, remove, or replace a type and thereby change validation for the process.

**Whether a type asks its recipient for an answer is part of the protocol, not a habit.** The ordinary type rows come from `ANSWER_EXPECTED` in `lib/answers.js`; its two readers are the loop guard and `promptobus status`. The `user` row is the orchestrator's narrow exception, read by `unansweredUserQuestions` in the same module.

| type | answer expected | what the answer is |
|---|---|---|
| `task` | yes | the hand-over of work: a `status` on taking it, a `result` when it is done |
| `question` | yes | an `answer` |
| `question` from `user` to `orchestrator` | yes, for the root or child orchestrator | an `answer` to `user`; a `status` or another send does not settle it |
| `review` | yes | a `result` with the notes closed |
| `result` | yes | the hand-over that asks for acceptance: a `review` with notes, or silence once accepted |
| `status` | **no** | nothing. A status is one-way — the sender must not end its turn waiting for an acknowledgement |
| `answer` | **no** | nothing; it is itself the answer to a `question` |
| `artifact` | **no** | nothing; the file is named in the message that carries it |

Two limits on reading that table. It says what a TYPE asks for, not what any particular participant owes: the orchestrator owes only the `user` question named above, while other addresses follow the ordinary rule ([03-cli.md](03-cli.md) § Guard and warden). And "no answer expected" never means "no need to read": the warden escalates an unread mailbox to `SILENT` for every address including the orchestrator, and that is unchanged.

When one session orchestrates several tasks, a user question in any of them holds that session's bound turn after its mailbox is read. Only an `answer` to `user` in the task where the question landed clears that debt.

Stored v1 messages carry `sender` and `recipients` as normalized participant IDs, the same values used for mailbox directories; they do not carry the caller's bus address spelling. For example, `worker:demo` is stored as `worker-demo`. Match a stored message by converting the address with the same normalization before comparing it.

`glanceInbox` only lists unread records; it does not consume them. A wait for a participant's verdict must therefore match both the normalized `sender` and `type`, rather than treating any `result` in the mailbox as that participant's message.

A `result` body opens with a fixed four-line header — what was done, the gate command with its exit code, what is left open, what needs a decision — inside a bound of 2400 characters, and everything past it is attached as an artifact the header names; the shape, the numbers and the gate record that goes with it are in § Artifacts, and the rule itself is stated in the participant preambles rather than in a consumer's rules.

`artifactPath` on send is an absolute file path. The file is copied into the task store. The message stores the artifact name.

During a consuming mailbox read, a filesystem refusal while reading or moving one record is reported with the errno in `BrokenNote.code` and leaves its ref in place for a later consuming read. The same pass still returns every message it already moved to history. The unread ref keeps the mailbox unread, so the warden repeats its knock until the filesystem condition is lifted. `recover()` applies the same per-record rule to an unreadable intent: it reports the errno, leaves the intent in place, and continues through the other intents and tasks. Only a record that was read and found malformed is moved to `broken/`.

`glanceInbox` reports a filesystem refusal as a `BrokenNote` without moving the ref; the bus itself adds a postcard line naming the errno and ref, and the participant status line repeats the health mark while retries remain unbounded until a later glance reads it. A record that does not parse is named the same way: the postcard line and the health mark carry `schema-invalid` with the ref name, and the glance still does not move the ref. That note does not hold the knock cutoff — a later retry carries only mail that arrived after the knock — while a refused ref still holds it, because a later glance may read the ref.

## Store layout

A task may carry `parent`, the id of a root task. The root's `links/<child-id>.json`
is a creation intent: it stores the child journal and the `teamlead:<slug>`
participant that belongs in the root. The child's `orchestrator` stores the
session in `metadata.owner`; the root's teamlead stores the same full session
in `metadata.sessionId`, so either address can pass the sender gate in its own
task. A child cannot name another child as parent. A task without `parent` is
a root and needs no teamlead.

The engine receives either a workspace `root`, which resolves to `<root>/.promptobus`, or the store `home` itself. It never searches for a root or reads an environment variable. Under `tasks/<task-id>/`, `task.json` is the journal; `messages/` holds canonical messages; `intents/` holds open fan-outs; `inbox/<participant>/` is unread mail; `history/<participant>/` is mail that was read; `blobs/` holds immutable SHA-256 payloads; and `artifacts/` holds their metadata. A task journal lock is `.lock/`. An open intent has a neighbouring `<id>.owner` lease. `broken/inbox/<participant>/`, `broken/artifacts/`, and `broken/messages/` isolate malformed records without taking the rest of the task down. The adapter's `files/` directory is a human-facing sidecar, not an engine v1 path.

Participant settings and launch sidecars use `participantFileStem`: a worker keeps
`<slug>`, while every other slugged address of the registry uses `<name>-<slug>` —
`reviewer-<slug>`, `approver-<slug>`, `teamlead-<slug>`, `root-<slug>`, `peer-<slug>` and a declared
step's. `reporter` is the sole bare address with a participant file stem:
`participantFileStem('reporter')` returns `reporter`. A worker name that begins with one of those prefixes, or that equals a slugless
address — `orchestrator`, `reporter`, `user` — is refused and the refusal names the role,
so two addresses cannot name the same sidecar.
`orchestrator` and `user` have no participant file stem. `done` removes contact
points for all three bare addresses by address. Its secret-file sweep skips
addresses without a participant file stem; for a dead reporter session it
removes the mcp-config, settings and participant directories as for any other
stemmed participant. Their participant records and mail remain in the task
journal.

Canonical messages, intent records and inbox or history references are hard links to one inode. Artifact blobs are immutable content-addressed payloads: multiple metadata records may name one blob. Immutability does not set their retention; `prune` removes a whole task and its blobs, while a live-task sweep may remove an accepted sender's unreferenced blob.

**Two locks, and they guard different things.** `.lock/` is the journal lock: the journal writers take it, and so does a piece sweep for the whole of its destructive stretch, worktree removal included. `.lock-blobs/` is the publication lock: a send that carries an artifact holds it while it writes the payload, names it and writes the metadata record, and a sweep holds it while it decides a payload is nobody's. A send with no artifact takes neither — the hot path of an ordinary message is untouched, and the measured cost on a send that does carry one is about half a millisecond, against a lock the journal holds across git.

The publication lock exists because the window between a payload and its record has nothing in it that names the payload: `stashBlob` finds an identical payload already there (`EEXIST` is dedup), and until the record lands a sweep reading the store sees a blob no record and no second link claims. Under the lock that window is not observable: a sweep either has not started or sees a finished publication. **`blobNamed` in `src/v1/artifacts.ts` is the one answer to "does anything still name this payload"** — a metadata record of the task, or a hard link beyond the blob file itself. `orphanBlobs` and the piece sweep both ask it, and both hand it one snapshot of the records rather than re-reading them per blob — that was measured at 400 artifacts, 3.8 s against 16 ms. What differs is WHEN the snapshot is read: the sweep reads it after the lock is in hand, so a record that landed while it waited is in the snapshot, and the only later change to the set is the sweep's own removals, which it tracks as it makes them. A listing reads it once because every blob should be judged against the same records.

**Publication holds the lock across an `await`, and that changes what a nesting licence may mean.** `withDirLock` lets a call nested inside this process's own critical section straight through, because a synchronous stretch cannot be interleaved and the nested call IS the same section. An `await` breaks that, so `withDirLockAsync` neither asks that licence nor hands it out: asynchronous holders of one lock path queue inside the process and each takes the directory in turn. A synchronous take arriving over a live asynchronous holder of the same process is refused outright rather than waited out, with its own code `lock-self-async` and not `lock-busy`: that one means "wait and retry", and here the wait is `sleepSync` and would block the very loop that has to release the lock. Waiting for a FOREIGN process differs by caller too: a synchronous take sits the hold out with `sleepSync`, because it has nothing else to do, while an asynchronous one awaits a timer — freezing the loop there would stop every other timer of the sender's own session for the length of a foreign hold, and a published asynchronous API has to behave as one. Two answers to that one question is the defect it replaced — the sweep read the link count, the engine read the records, and a payload could be nobody's to one of them while the other still held it. The full task tree and the safe deletion boundary for these paths are listed in [01-overview](01-overview.md) § Store home.

`promptobus sweep <address>` is the one cleanup that works inside a LIVE task, and it stays outside the engine for that reason: `engine.prune` refuses on an active task, and the moment one piece is accepted the task is active by definition. It removes the artifact metadata records of one sender, their `files/` entries and blobs that no surviving metadata record or other hard link names — never a canonical message, an inbox or history reference, a `waits/` sidecar, `health.json`, `supervisor.log` or `stalls.json`. A blob still leaves only when nothing names it, and a re-send of the same payload writes it again. A `files/` entry is addressed by the `filename` the record carries, which `sendSync` fills from the adapter's placement callback AFTER the digest, so a second send of one payload is recorded under the numbered name that actually landed. Which record an entry belongs to is then proven by the inode the two share, because a name without that proof could name a foreign file and an inode without the name cannot separate two entries of one deduplicated blob. The command is in [03-cli](03-cli.md) § Status, done, dismiss, history, prune.

## Fan-out

`send` validates the active task, sender, recipients, message type, body and routing policy before its first side effect. If an artifact is present, its name is checked first; the payload is then streamed or read once into a content-addressed blob and its metadata is validated and written before the message. The same checks apply to `sendSync`.

The message commit point is the exclusive creation of `intents/<id>.json` with `wx`. The intent is the complete canonical message, including recipients, and the sender writes `<id>.owner` beside it as a best-effort lease. The engine then links the intent to `messages/<id>.json`, links one reference to each recipient's inbox, and removes the intent and lease only after every reference exists. Each link is idempotent: `EEXIST` means the neighbouring pass already put that link. Hard links must stay on one filesystem; a lawful refusal is the typed `link-refused` result and leaves the intent open for recovery.

The engine returns `ActivationEvent` values after the fan-out is on disk. It does not wake participants itself: the supervisor and driver activate each recipient independently. A message can therefore be fully durable while activation is still pending.

## Recovery

Task-link recovery runs before message fan-out recovery. Under the root journal
lock it reads each `links/` intent, creates a missing child journal, registers
a missing teamlead participant, and removes the intent after both exist. The
`links` result names each repaired parent and child and which half was missing;
`linkFailures` names an intent that remains for another pass. A child link
fault hook fires after the child journal write and before the parent journal
write, so the suite can prove this recovery path.

`recoverTask` walks unclosed `.json` intents and repairs the missing canonical link or recipient references. It checks both `inbox/` and `history/` before adding a reference, so a message already read during a crash is not delivered a second time. A lease from the same host can identify a dead owner; an intent older than `INTENT_STALE_MS = 30_000` milliseconds is abandoned regardless of its lease.

The recovery result separates repaired fan-outs, activation events, unreadable records and failed materializations. A filesystem refusal such as `link-refused`, `dir-blocked` or `dir-occupied` leaves the intent for a later pass; if both the intent and canonical message have disappeared at materialization, the failure is `intent-lost` and is not retried. A canonical-directory mkdir `ENOENT` is not that disappearance: the intent file is still there, the refusal is `dir-occupied`, and the next pass delivers once the dangling symlink is gone. A malformed intent is isolated in `broken/messages/`, while a newer schema stays in place as `schema-version-unsupported`. Recovery continues through neighbouring intents and tasks; unrelated exceptions escape. Orphaned `.owner` files are swept after the same directory listing. The stable contract marker for `consumer-cli` lint is `intent-stale-ms: 30` (seconds).

## Validation

The optional `parent` is a task id string, not an embedded task. The schema
and runtime validator reject a child journal carrying a `teamlead` role or a
`teamlead:` address. The runtime also rejects self-parenting; JSON Schema
cannot compare the values of `id` and `parent` in one record. Creation checks
the named journal under its lock: a child cannot become a parent, a closed
root cannot take a child, and the full teamlead session must equal the child
owner session. A task's parent is immutable after creation. An unfinished
link blocks another child creation until recovery, reserving its teamlead
address. Closing a root refuses while a child is active or a link intent is
unfinished, naming the child. Closing a child leaves the root's teamlead
participant and correspondence intact.

Runtime validation is implemented in `src/v1/validate.ts`, not by reading the JSON Schema files. The four models are `task`, `participant`, `message` and `artifact`. The validator checks the version first, rejects unfamiliar fields, then checks required fields and their grammars; a newer record returns `schema-version-unsupported`, while malformed data returns `schema-invalid`. `requireValid` turns the verdict into a typed `PromptobusError` before a write, so invalid task, participant, message or artifact data never enters the store.

The task and artifact records use schema version `1`, messages use protocol version `1`, participant ids and task ids are bounded ASCII names, message recipients are non-empty and unique, message types come from the frozen v1 list, and artifact metadata points only to a `blobs/<sha256>` path. A reader isolates malformed records when the operation allows it; it does not treat a newer record as corruption or silently migrate it.

**A rule about what may be WRITTEN does not belong here.** Record validation runs on every read — `readInbox`, `peekInbox` and `history` alike — and a schema-invalid record is moved to `broken/inbox`, so a constraint added to this list reaches backwards over every journal already on disk and stops delivering records an earlier release wrote lawfully. The `type=artifact` invariant is the worked example: it is enforced at the write, in the engine's `prepare` and at the tool boundary, and record validation stays silent about it, so a `type=artifact` record written before that refusal existed still reads as written. Tightening this list is a protocol-version change, not a patch.

## Fault injection

Child creation writes a complete temporary journal, then publishes it with an
exclusive hard link. A crash before publication leaves the root's link intent
but no partial child journal. Recovery creates the child from that intent and
then registers the teamlead; a malformed intent is named in `linkFailures`
without stopping recovery of other links.

`task-link-publish` fires after the temporary child journal is complete and
before exclusive publication; `task-link` fires after publication and before
the root journal write. Their contexts name the child, and a throw leaves the
creation intent for `recover()`.

`EngineOptions.faults` accepts the test-only `FaultHook`; production does not supply it. Fan-out hooks run after durable `validate`, `blob`, `artifact`, `intent`, `canonical`, `ref` and `close` steps. The `read` hook marks the completed mailbox read. Read hooks run immediately before their named filesystem operation: `task-read`, `artifact-read`, `intent-read`, `inbox-read` (with `mode: "read"` for consuming reads, `mode: "peek"` for a foreign session's copy and `mode: "glance"` for warden glances) and `history-ref` — `artifact-read` fires before both the metadata read and the blob read of an artifact, and its `file` context says which; `intent-materialize` runs after intent validation and immediately before recovery materializes the message. The `mkdir` hook runs immediately before the directory create inside a fan-out link, for the canonical message and for each recipient reference; `target` is that directory and `to` is the link, and a throw there is classified as the directory refusal. A hook throw models a crash or filesystem refusal at that boundary so the suite can prove recovery without changing production behaviour. The warden's `supervisorRound` supplies its own `faults` option for the glance because `engine.glance` does not pass the engine hook. The artifact seam covers the direct reads only. The bulk listing — every caller of the exported `listArtifacts` — takes no fault hook.

## Engine

`openEngine({ root, policy })` or `openEngine({ home, policy })`. Exactly one of `root` / `home`. `policy` is required at open: a callback `{ allow: true } | { deny: true, reason }` per sender/recipient pair.

The engine does not wake anyone. It returns activation events. The warden and the driver wake the session.

Recovery is local to one intent. `RecoverResult` carries `repairs`, activation `events`, unreadable `broken` records, and `failed` fan-outs. A classified hard-link refusal adds `{ task, message, code: "link-refused", note }` to `failed`, leaves the intent for the next pass, and continues through the other intents and tasks. If materialization finds that both the intent and canon are gone, the same entry instead carries `code: "intent-lost"`: the message is permanently lost and will not be retried, but recovery still continues. Neither result aborts `openEngine({ recover: true })`. Other exceptions escape; recovery does not hide programmer errors or broaden the filesystem refusal taxonomy. A classified refusal while creating a recipient inbox directory uses the same `link-refused` classification, leaves the intent for retry, and does not abort open-time recovery. Mkdir errnos outside that hard-link list are classified only for this set: `EROFS` and `ENOSPC` are `dir-blocked` (delivered once the volume is writable again, or has space); `EEXIST` and `ENOTDIR` are `dir-occupied` (remove or move the stray file the error names); `ENOENT` and `ELOOP` are `dir-occupied` on the canonical directory and on a recipient directory (a dangling symlink, or a symlink loop). A `dir-blocked` refusal tells the sender the message is already committed and is delivered once the volume is writable again or has space, and a `dir-occupied` refusal says it is delivered once the path is clear; either way the sender must not resend. Any other mkdir errno escapes raw. A link `ENOENT` — the intent file itself gone, and no canon — is still `intent-lost`. The classified codes carry the errno and the path, leave the intent open, and do not abort open-time recovery. The no-argument `recover()` and `history()` operations cover readable tasks only; callers that need unreadable task journals pair them with `listTasks().broken`, while `RecoverResult.broken` remains for unreadable records inside a readable task.

The bus adapter opens with implicit recovery disabled, calls `recover()` once on the first access to a store in the process, and prints warnings for repaired fan-outs, unreadable records, retryable refusals, and permanent message loss before caching the engine. Both failure classes are therefore visible while `status`, `history`, `prune`, the warden, and MCP calls can still open the store. A later process retries a retained `link-refused`, `dir-blocked` or `dir-occupied` intent.

Every entry point selects `host.version` for the store home it will actually use. CLI dispatch selects it for the host-home commands (`spawn`, `review`, `status`, `done`, `dismiss`, `history`, and `prune`); the warden, guard, MCP server and `send` select it after resolving their own home. An explicit `bus()` open without a reader version is a programming error, and engines are cached by store home and reader version, so an earlier access cannot leave a later reader using the wrong diagnosis vocabulary. A low-level adapter helper that reaches an unselected home warns once that it has an unversioned reader.

New orchestrator records carry the selected version when a task is created and when its mailbox is claimed. If no version was selected, those writers warn with the home and record and leave `mechanismVersion` absent instead of inventing a release. If a participant record has unfamiliar fields and was written by a newer mechanism, the refusal is `schema-version-unsupported` and names both the writer and reader versions; prerelease and build suffixes are ignored for this newer-than comparison, while the original version strings remain in the diagnosis.

Mail is kept until read. Read is a rename from `inbox/` to `history/`. There is no exactly-once processing after that.

## Participant metadata

The v1 record's own fields are `id`, `role`, `harness`, `mode`, `sessionRef`, `capabilities`. Everything else the adapter writes about a participant lives in `metadata`, which the core does not look into, and the door into it is the accessors of `src/protocol.ts` — not a scatter of `p.metadata.<field>` reads.

`capabilities` is the driver's snapshot at lift time: `spawn`, `attach`, `activation`, `inspect` and `stop` are required; `denyTools`, `mcpDenyTools`, `systemPrompt`, `sessionList`, `enter` and `approverLift` are optional. `mcpDenyTools` and `approverLift` are additive contract extensions: a record from before either appeared remains readable without the field.

`metadata.routing` is one such field: the decision a lift made under `--strategy` ([03-cli](03-cli.md) § Model routing). It is written by `spawn` and `review` at the lift and read by `promptobus status` through `routingOf`, and it carries the strategy, the role, the tuple (`tupleId`, `harness`, `model`, `effort`), the chosen candidate's `score`, `strategySource` when the strategy came from a merged `defaults.strategy` rather than from a flag — absent when a person typed one, because there is nowhere else that value could have come from — the `snapshot` the pick was made on (`takenAt`, `ageSec`, `source`), the `windows` applicable to the chosen tuple with the `usedPercent` they had at that moment — the starting value the spend of a run is later read as a delta from, empty when the harness reported none — the `warnings` as codes, `nearLimit` — one `{ harness, usedPercent }` per `near-limit` warning, present only when one was raised, which is what lets the routing line print `near-limit codex 96 %` — `nearlySpent` — one `{ harness, pool?, usedPercent }` per harness, or per pool where the excluded window's scope names one, whose tuples left selection as `window-nearly-spent`, at the highest used percentage among them, present only when one did, printed as `window-nearly-spent codex 96 %` or `window-nearly-spent cursor api 72 %` — and the `constraints` with `applied`. An unrouted participant has no such field.

**The protocol version is not raised for it.** `metadata` is declared open in `schemas/v1/participant.schema.json`, so a record carrying a routing decision is readable by a mechanism of any version — which is exactly what that field exists for. A routed run is not migrated to and not migrated from: the decision describes the lift that happened, and a reader that does not know the field ignores it.

## Artifacts

An artifact is attached to a send. There is no separate upload command. **A message of type `artifact` always carries a file**: `send` refuses `type: "artifact"` with no `artifactPath`, and the refusal names that parameter. The refusal stands in `sendMessage` (`lib/store.js`), where both callers meet — the `promptobus_send` tool and the `send` command ([03-cli](03-cli.md) § Send) — so both are refused in the same words. The engine holds the same rule one layer down, so a message built past the adapter — through the public `send`/`sendSync` — cannot claim an attachment it does not carry: `prepare` refuses `type: "artifact"` that names no file at all, before the first side effect, and the refusal names both fields that can name one — `artifact` for a new attachment and `linkArtifact` for one already in the task. Linking satisfies the invariant, and the id is checked rather than trusted: `prepare` asks whether that artifact record is in **this** task and refuses `artifact-not-found` naming the id when it is not, so an id of the right shape pointing at nothing cannot write the very message this refusal exists against. **Presence is asked without reading the record** — `readArtifact` sets a corrupt one aside, and prevalidation leaves the task exactly as it found it; a broken record is classified by whoever reads it next, not by a send that may yet be refused by the routing policy. `finish` then writes that id into the record, and no second blob is stashed for bytes the task already holds. **The invariant is held at the WRITE and only there.** Record validation is deliberately unchanged: a reader isolates a schema-invalid record into `broken/inbox`, so binding the two fields in `validate` would reach backwards and stop delivering `type=artifact` records that earlier releases wrote without a file — records that exist in live journals. A record of that shape reads exactly as it was written, and no send can produce another. What the file holds is not judged here; the gate record and the handover record are checked against their own schemas, below. Blobs are content-addressed (`blobs/<sha256>`) and immutable inside one task. Missing metadata or a missing blob is `artifact-not-found`; metadata or a blob that exists but cannot be read with an errno other than `ENOENT` is `artifact-broken`, with the errno in `context`. The same `artifact-read` hook runs immediately before each metadata or blob read, and its `file` context distinguishes the two. Unparseable metadata and parsed metadata that violates the current schema are `schema-invalid` and are set aside in `broken/artifacts` when the move succeeds; metadata from a newer schema is `schema-version-unsupported` and stays in place. A blob whose digest or size differs from its metadata is `artifact-integrity`.

The name a sender passes is not always the name the artifact gets. **Leading dots are dropped** (`.gates-t2.json` lands as `gates-t2.json`): a hidden file is missed by an ordinary listing and by a `*.json` glob, and a reviewer handed that folder as its source of evidence reported a record that was there as absent — measured live, one name. A name of nothing but dots has no visible form left and is refused to the sender rather than landed hidden. Then `placeFile` takes the next free number on a taken stem (`report.md`, then `report-2.md`), and the numbering runs on the name that LANDS, so two sources differing only by a leading dot take two names instead of one silently shadowing the other; a name a mechanism file of the folder already holds is a collision like any other and is numbered the same way. The send reply prints the name that landed. A worker or approver that will name an artifact in its result sends that artifact first as its own message, reads the landed name from the immediate bus reply to its own `promptobus_send` call for that artifact — not from the path passed and not from the orchestrator — and, without ending the turn, puts that name in the result header. A reviewer cannot attach a file: file writes are disabled for it, so it cannot produce an artifact of its own — but it may **cite** a landed filename another participant sent, for example the author's gate record in its **Gate** line.

**A repeat of the same bytes is said out loud.** Blobs are content-addressed, so sending the same payload twice is lawful and costs nothing — two names, one inode. The send reply names the file that already holds those bytes (`the same content as report.md`) and, where the hard-link count is readable, how many names the payload now has. The line is assertive rather than a warning: the repeat is legitimate and often deliberate. What it answers is the one thing the sender cannot see — a participant who believed they had sent a corrected file got a reply indistinguishable from the reply to a new version, and the mechanism held the fact that would have said otherwise. The reading is of CONTENT: the same bytes under a different source name are still a repeat, and different bytes under the same source name are not.

**Hand-off order is machine-visible.** A claim is a **landed** filename that appears in the **Gate** or **Decide** line — dotted prose that matches no task artifact is not a claim. `send` refuses a landed name with no `artifact` message from **any** sender; citing another participant's landed file is lawful. The canonical result carries one metadata id in its `artifact` field — the first claimed landed name in header order that **this** sender also sent as an `artifact` message — using the frozen v1 field, not a new schema key. A citation with no own `artifact` message leaves the field unset. A result with no landed-name claim is lawful and is not judged. The loop guard adds a second case answer expectation cannot see: a gate-record artifact (`gates-<slug>.json`, with `numberedName` when the stem collides) sent since the last turn end with no `result` from the same sender in between holds the turn until the result goes out.

**An address's attachments are visible to its reviewer.** Every artifact an address sends into a task before `review` runs is listed in that address's review subject by landed name, type and send moment, taken from the journal rather than from a name pattern; one sent after that moment arrives with the next re-review ([03-cli](03-cli.md#review) § Review).


### The result hand-off

A result body is at most `RESULT_BODY_MAX` = 2400 characters and opens with four lines — **Done**, **Gate**, **Open**, **Decide**. The four lines are the whole form; what grew beside them is the evidence, and it travels as records rather than sentences — [the gate record](#the-gate-record) for what was run, which a worker and an approver both carry, and [the handover record](#the-handover-record) for why that run means anything, which is the **worker's alone**: an approver merges rather than writes code, and its own gate run is the integration gate. Everything past that bound travels as an artifact; a worker or approver sends it before the result so the header can name its landed filename. The number is measured rather than chosen: five real result bodies already written in this shape ran 1035, 1389, 1674, 2045 and 2100 characters, against a median of 5254 over 1151 free-text results, and a bound below what already worked would make the rule the defect. The worker, reviewer and approver preambles state it from one constant in `lib/handoff.js` — a number written twice drifts, and one role would then hold a different rule from another.

Before the gate record and the handover record are sent, the worker runs `npm run schema-skew`. A refusal there means the running bus would reject the record, so the record stays in the shape the installed schema already accepts. What the check compares, and why a new field waits for the next release, is under [the gate record](#the-gate-record) and [the handover record](#the-handover-record). The command is not a project gate.

The rule lives in the preambles (`lib/spawn.js`, `lib/review.js` and `lib/approver.js`) and not only here, because a convention kept in a consumer's own rules is not delivered to a participant this package lifts.

**The Gate line is never omitted.** A gate that was not run says `not run, because …` with the reason; an omitted line reads as a green one. The line "gates N, green M" counts by command, and only the entries whose `tree` and `dirty` match the tree the line is about — a worker's clean HEAD, an approver's merged tree. Entries on other trees are history and are not counted. N is the number of distinct `command` values among those gate entries — an entry with no `kind`, or `kind` `gate`. Different spellings of one command are different commands; keep one spelling. M is how many of those have a latest entry that exits 0. An entry whose `counts` carry `gates` and `green` is the aggregate itself, not a gate, and is not counted in N. When the record has no per-command gate entries, the runner entry's own `gates` and `green` are the line. When per-command entries exist, they are counted by command and must agree with the runner entry when the record has one. An entry with `kind` `verification` is a card's own run and is left out of both. After the aggregate, the Gate line names each verification run with its exit code, or says "verification K, green L". A reviewer writes that line on every report it sends — it runs nothing by [ADR-009](../adr/adr-009-reviewer-resolves-no-discrepancy.md) — which is why the line cannot be read as an escape hatch: it is the normal state of the role that runs no gates. An approver may **cite** another participant's landed artifact in the **Gate** line — the worker's gate record is the usual case — while its own overflow and gate record still bind only to its own send.

**The overflow rule is the worker's and the approver's, not the reviewer's.** A worker's and an approver's body is bounded and what does not fit is attached; a reviewer cannot attach anything — file writes are denied to it, and its own isolation text forbids publishing an artifact — so for a reviewer the bound covers the header alone and the findings follow it unbounded in the same body. A limit its holder cannot satisfy is not a strict rule but a wall, and one that would be broken silently on every long review.

### The gate record

A worker's or approver's gate claim travels as a record. `schemas/v1/gate-record.schema.json` is its shape: one entry per gate command carrying the `command` as executed, its `exit` code, the `counts` the runner printed under the runner's own names, the `tree` it ran on, whether that tree was `dirty`, the timestamp `at`, the address `by` (`orchestrator` or `<step>:<slug>`), an optional `kind`, and a `tail` of the output. It is the payload of an artifact sent before the result as its own `artifact` message, and the ENGINE does not validate it: `validate` knows four models, and an artifact's bytes are opaque to it. `test/gate-record.test.mjs` asserts that `validate` goes on not knowing the name — a fifth file in `schemas/v1/` would otherwise read as a fifth engine model.

**An entry's `kind` is `gate` or `verification`, and absent means `gate`.** A record written before the field keeps passing: nothing is migrated, and a missing `kind` is a project gate. `verification` is one run a card asked for beside the project gates. It uses the same `command` field — the command as executed — and nothing else is required of it. It is not a project gate, and it is not a sixth check of [the handover record](#the-handover-record), which keeps its five. The line "gates N, green M" counts by command, and only the entries whose `tree` and `dirty` match the tree the line is about — a worker's clean HEAD, an approver's merged tree. Entries on other trees are history and are not counted. N is the number of distinct `command` values among those gate entries — an entry with no `kind`, or `kind` `gate`. Different spellings of one command are different commands; keep one spelling. M is how many of those have a latest entry that exits 0. An entry whose `counts` carry `gates` and `green` is the aggregate itself, not a gate, and is not counted in N. When the record has no per-command gate entries, the runner entry's own `gates` and `green` are the line. When per-command entries exist, they are counted by command and must agree with the runner entry when the record has one. An entry with `kind` `verification` is a card's own run and is left out of both. After the aggregate, the Gate line names each verification run with its exit code, or says "verification K, green L". **`kind` can first be sent in the release after the one that adds it.** `send` reads the installed copy of this schema, which does not define the field until that release, so the run that adds it writes its own gate record without `kind`. `npm run schema-skew` names that path; the refusal is the expected difference and is not repaired by taking the field out.

**`send` does check it, and refuses.** A document its own schema rejects looks like evidence and is not, and nobody opens the schema by hand in time: measured on one run, two of three attached records diverged from it and both authors learnt so from a reviewer reading the schema by eye. So a file whose name claims the stem — `gates-*.json`, and `handover-*.json` for [the handover record](#the-handover-record) — is read and checked against the published schema BEFORE its payload is written, and an invalid one is refused to the sender with the faults listed by field. A valid one passes through byte for byte; a file that claims neither stem is opaque bytes as before. The check is `lib/handoff.js`, over the same two name recognisers `review` resolves the attached records with — one door, not two.

Both schemas give `by` the generic address grammar `^(orchestrator|[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*)$`. After the schema check, `recordRefusal` asks the registry passed by `sendMessage` whether it admits every gate entry's `by`, or the handover record's `by`. The CLI and MCP send doors pass their host's registry; a low-level call without one uses the shipped registry. A name the registry does not admit is refused by name before the artifact is written. This admits a renamed owner step such as `builder:<slug>` when the declaration names it, and refuses the same address when it does not.

The reader is `lib/schema.js` and it reads the schema FILE rather than a second copy of its rules, so the two cannot drift. The reference validator stays `ajv`, a devDependency: the package ships with no runtime dependencies, and that is a gate of its own suite. The pairing is the one `test/v1-validate.test.mjs` already makes for the four engine models — one fixture set, two verdicts, and they must agree on every document. A schema keyword the reader does not implement makes it throw rather than answer: a partial verdict handed over as a pass is the failure the check exists against.

**A field added to this schema can first be sent in the release after the one that adds it.** `send` reads the schema from the package it is running, which is the installed copy, and `additionalProperties: false` refuses a property that copy does not define. From the commit that adds the field until the release that ships it, the checkout and the installed copy are different files, and the run that adds the field writes its own record in the previous shape. `npm run schema-skew` ([scripts/check-schema-skew.mjs](../../scripts/check-schema-skew.mjs)) compares every `schemas/v1/*-record.schema.json` in the checkout with the same file in the installed package, and only for the keywords [the reader](../../lib/schema.js) implements. A refusal is a fault that reader raises on the installed schema at a path and does not raise on the checkout schema — a property it does not define, or a required field that is missing — so a new field is named even when the rest of the witness fails a `pattern`. A `const` or a type is that same difference on the keyword itself. An unmatched `oneOf` branch is judged alone against each installed branch, and it is a refusal only when every one of them has a fault — path and text — that the checkout branch does not; the count of branches is not the comparison, so a pattern fault they share is not a refusal. When the installed node has no `oneOf`, that node is the one branch, and a checkout `oneOf` it accepts is not a refusal. A `pattern` or a bound, changed on its own, is outside what it reports: the reader is not asked to invent a string. Each line names the schema, the path, and that the record can carry that field from the next release on. The default is the copy Node finds by walking module paths from the checkout upward, and that line is part of the output; it is the running bus's copy only when the package is hoisted there. `--resolve-from` takes the directory of the running bus when it is not. It exits 1 when it names a path, and 0 when it names none. With no package on the path it prints `not run: no installed promptobus package found` and exits 0. It is not a project gate: the difference is accepted, so `main` and the installed package disagree for that whole interval, and a gate on every acceptance would stay red the entire time. The worker runs it before sending the records; the hand-off above says the same.

**The mutation probe has no place in this schema, on purpose.** All three authors of that run needed one and expressed it three ways. A probe is not a gate command, and the record is one entry per command that ran: its home is `checks.mutationProbe` of [the handover record](#the-handover-record), which states the sha, the `file:line` broken, the mutated run's exit code, the counts and the names that reddened. A probe reported here as a `command` with an `exit` is schema-valid and says nothing the reviewer can check.

**The file is named, not described.** A worker requests the stem `gates-<worker slug>.json` (`GATE_RECORD_STEM` in `lib/handoff.js`); an approver requests `gates-<approver slug>.json`. Each sends the record before the result as its own `artifact` message, and reads the landed filename from the immediate bus reply to its own `promptobus_send` call — without ending the turn — for the Gate line. The bus may append a number to avoid a collision, and that returned name is the one the header quotes. `review` resolves every `gates-*.json` in the task files folder into absolute paths that go into both the first prompt and the re-review. Describing it as "a JSON file beside the diff" was not an address: that folder holds every worker's attachments and every review round's, and the result naming the right one reaches the orchestrator alone. Several records at once is a normal state — the `tree` field is what tells them apart, and none matching the reviewed sha means no record covers that tree. `numberedName` gives a repeat attachment the next number (`gates-x-2.json`), so a round does not overwrite the round before it.

`tree` is the HEAD commit sha, what `git rev-parse HEAD` prints. Not a git tree-object sha: the reviewer is handed `worktree HEAD <sha>` from the same call in its own prompt, so a tree-object sha would never compare equal and the comparison would be dead on the day it shipped. The pair is also what a runner already prints — `backslop gates` closes with `tree: <sha>, dirty`.

`tree` carries the full sha and nothing shorter. The comparison is an exact string match, so an abbreviation is a schema-valid record that could never match — measured before the bound was narrowed: `1966ace` passed the schema and is not equal to the `1966aceb…6de` the reviewer is handed.

**The comparison is the whole point, and so is its limit.** Same sha with `dirty: false` and `exit: 0` — the claim is evidence about **the commit at that sha, and about nothing else**. The review subject can hold more than that commit does: uncommitted tracked changes and untracked files both leave HEAD where it was, and `snapshot.clean` does not look at untracked paths at all, so a truthful record on a matching sha can still say nothing about part of what is under review. The reviewer is handed both facts in its subject line and is told to name the gap rather than let a matching sha stand for the whole subject. Another sha, a dirty tree, a non-zero exit, or no record at all — it is not evidence about that tree, the reviewer names which of the four it was, and the acceptance goes on with the gap named rather than being refused. Refusing outright was considered and rejected: a participant whose sandbox cannot run part of the set would then be unacceptable for ever, which is a wall and not a gate. What the record cannot do is prove the run happened — an author can write `exit: 0` beside the right sha having run nothing. Only a re-run on that sha by someone allowed to run catches that, and neither the record nor the reviewer is that someone.

**Size.** `tail` is bounded at `GATE_TAIL_MAX` = 2000 characters and `records` at 16 entries — at most 32 000 characters of output per document, against 350 480 that one green run of this repository's own chain prints. The bound is read off that run: a command's own summary sits in its last five lines (260 characters), and the longest red diagnosis measured — 22 lint findings with their summary — runs 2450 characters over its last twenty lines, of which 2000 carries the summary and the last sixteen findings. What the bound refuses to carry is a wall of repetitions, and that is the case where the log, not the record, is the right place.

### The handover record

The gate record says WHAT was run. It does not say why that run means anything, and the difference is not rhetoric: a suite that goes 244 to 242 to 246 reads as growth while a guarantee is gone, a mutation probe that stopped early prints `0/1` against a base of 26 and reads as catastrophe when it means interruption, and a red called environmental is a word until someone runs it on the base commit. None of those is a judgement — each is a command and an exit code, and the reviewer cannot run any of them ([ADR-009](../adr/adr-009-reviewer-resolves-no-discrepancy.md)). So they travel as a second record, sent the same way and read the same way.

`schemas/v1/handover-record.schema.json` is its shape: the branch `tree`, the `base` sha it was compared against, `at`, `by`, and `checks` — five of them, all required. **A check left out is not a check passed.** The only way past one is its own `notRun` branch carrying a reason, and a check honestly declared impossible passes: a form with no such branch is a form that rewards invented numbers, which is the defect [the gate record](#the-gate-record) was written against. The five are `verdictNames` (every name on base and not on the branch, each with why it went, or the explicit empty list — the check is defined by what went, and names that appeared need no defence), `mutationProbe` (the sha, the `file:line` broken, the mutated run's exit code, the counts, the names that reddened, optionally the names it was made to redden, and optionally why that sha is not the record's `tree`), `treeState` (`git status --porcelain` before the probe and after the restore), `environmentalRed` (per claim: the assertion in full, the same verdict run on base, and the symmetric difference of the failure sets) and `gatesNotRun` (per command, its reason). `HANDOVER_CHECKS` in `lib/handoff.js` is the one list the preambles and the schema are both read against.

**A field added to this schema can first be sent in the release after the one that adds it.** `send` checks the installed package's copy of this file, the same way it checks [the gate record](#the-gate-record), so the run that adds the field cannot put the field in its own handover record. `npm run schema-skew`, run before that send, names the schema and the path; the record it would refuse stays in the previous shape until the next release. The check is the one the gate-record section describes, and it covers this schema the same way.

**Each check refuses its own defeat, in the schema and not in prose.** A removed verdict name with no `reason` is refused; a probe with `applied: false` is refused, because a mutation that never reached the code measured the unmutated tree; a probe with an empty `reddened` is refused, because a probe that turns nothing red found a hole in the tests rather than a fact to hand over; `treeState` takes the empty string at both ends and nothing else; a claim of "environmental" whose base run is green is refused, because red here and green on base is the author's own change; and a gate with no `because` is refused.

**Two exit codes meet at the probe and only one is recorded.** `npm run probe` in this repository leaves 0 on its single passing outcome — red with the mutation, green without it — and 1 on every other, so the probe tool's own code says pass or fail and nothing about the tree. What the record carries is `mutatedRunExit`, the code of the run made WITH the mutation in place, and it is at least 1: a run that reddened a verdict cannot have exited 0, and one that exited 0 saw nothing, which is a hole in the checks rather than a handover. The field is named rather than called `exit` because the two readings were measurably easy to swap.

**The probe names its target, and the door compares the two fields.** `reddened` says what went red; `expected` says what the mutation was made to redden, written down before the run. Without the second, a probe that reddened the wrong thing is indistinguishable from one that worked, and both live cases behind this were found by a person reading the content of the redness rather than its presence: a fixture on a relative path whose refusal came from `path.resolve` and never reached the gate under test — green with the gate removed — and a file that exited through `fail()` partway, producing no verdicts at all below that line. So `send` refuses a record whose `reddened` does not carry every name in `expected`, and the refusal prints both lists whole and then the names that never reddened. Both lists whole, because printing the missing part alone made a target that WAS hit read as a stray: with `expected` of two and one of them red, nothing left in the refusal said the red one had been declared. The diagnosis after the data differs by branch, because the two cases are different defects: nothing declared reddening is a probe that measured something other than the change, while SOME of it reddening means the mutation bit and either the rest of the targets do not cover the line it broke or they were the wrong ones to declare. The refusal is read by whoever comes to fix the probe, and one generalisation over both sends half of them looking the wrong way. **Subset, not equality:** more names in `reddened` is a wider net, not a wrong probe — a neighbouring verdict that also caught the mutation is evidence the mutation bit. The comparison sits in `recordRefusal` (`lib/handoff.js`) beside the schema pass and not inside the schema, because JSON Schema cannot compare two of its own fields and the reader in `lib/schema.js` implements a subset that deliberately cannot either; it is the same door both records already go through, so there is no second validator to drift from the first.

**The field is optional, and that is a compatibility guarantee rather than a claim.** Consumers hold records written by the previous version and read them mid-run, so a record that carries no `expected` passes exactly as it did — `test/promptobus-adapter.test.mjs` sends one through the door and `test/promptobus-spawn.test.mjs` sends another as part of an unrelated ordering check, which is what makes the compatibility something that turns red when broken. Nothing but the worker preamble then makes a new record carry the field; a schema-optional field with no prompt behind it is a field no record has.

**What it proves, and the two things it does not.** It catches the careless probe — the one that reddened something other than the target while the author did not look. It does not catch a dishonest one: the record is written after the run, so an author who copies `reddened` into `expected` produces a document this check accepts, the same limit the record already carries in "it cannot prove the run happened". And it does not catch the **aborted run**, which is the more expensive of the two failure modes: a file that dies partway can legitimately hold every declared name in `reddened` — they ran before the abort — while every verdict below that line silently produced nothing, and the record reads clean. Closing that one means counting executed verdicts against a base total in the runner, which belongs to the consumer's own suite and not to this schema; `verdicts.unaccounted` below is the nearest this record comes to it. `send` compares the stated remainder with `baseTotal − passed − reddened.length`. What that comparison still does not catch is a consistent set of wrong numbers: every figure can come from one capture of a different invocation, and a document whose subtraction equals the stated remainder passes.

**The truncated run is caught by arithmetic `send` checks.** `verdicts.unaccounted` is `baseTotal − passed − reddened.length` and the schema still accepts only `0`. JSON Schema cannot compare two of its own fields, and the reader in `lib/schema.js` cannot either, so the subtraction is not a schema keyword. `recordRefusal` (`lib/handoff.js`) compares the two sides after the shape check — the same door as `expected` against `reddened` — and refuses when they differ, naming both: what `baseTotal − passed − reddened.length` comes to, and the `unaccounted` the record states. The diagnosis after that data splits on the sign, for the same reason the intent refusal does: one sentence for both sends the author the wrong way. A positive remainder is verdicts the mutated run never reached, or names missing from `reddened` — run again or declare `notRun`. The count agrees in number: a remainder of one says verdict. A negative remainder is more verdicts than the base run has — numbers from another invocation. The restored run is this second shape: `passed` equal to `baseTotal`, a non-empty `reddened`, and `unaccounted: 0` stated, which used to pass every check the schema has. A stated non-zero remainder never reaches the comparison: the schema refuses it first. `reddened.length` counts listings, not distinct names. A repeated name is two verdicts, because two checks may share a name, and the schema has no uniqueness keyword the reader could apply. A consistent set of wrong numbers still passes. The check sees one document and cannot tell that every figure was copied from a capture of a different invocation.

**The probe's tree and the tree being handed over are compared in that same door.** `tree` is the sha the hand-off describes; `checks.mutationProbe.tree` is the sha the probe ran on. HEAD moves during a review round, and each move leaves the probe behind unless it is re-run, so a record whose two shas differ is claiming a probe of code that is no longer the code being accepted — while every field can still be present and well-formed. `send` compares them in `recordRefusal` after the schema pass: equal, and there is nothing to say, whether or not a reason is attached; they differ and `mutationProbe.treeLag` is absent, and the record is refused with both shas named; they differ and `treeLag` is present, and the record is accepted unchanged. A probe kept on an earlier sha is legitimate when the commits since then did not touch the mutated file or the tests whose verdicts are in `reddened`, and `treeLag` is where the record says so. It is a `reason` — prose of at least eight characters — not a list of those commits. The door does not read the prose against git and does not require it to name the moves: it compares two claims in one document, the same limit as `expected` against `reddened`. What supports the reason is `git log --oneline <probe.tree>..<tree> -- <mutated file> <files of the tests in reddened>`; empty output is the claim, and a non-empty log is a probe of code the hand-off has left. The worker preamble requires `treeLag` for an earlier sha from the release that ships the field. The reviewer preamble names a present `treeLag` together with both shas and does not take that probe as covering HEAD. **No migration.** The field is optional, so a record written before it exists, whose two shas agree, passes exactly as it did; a difference with no reason is the refusal this check exists for, not a document to rewrite. **`treeLag` inherits the release seam** stated above: the running bus validates the installed package's copy of this schema, so the run that adds the field cannot put it in its own handover record. The tests of the comparison go through this checkout's own validator. `npm run schema-skew`, run before that send, names the field the running bus would refuse.

**The file is named, not described,** exactly as the gate record is: the stem is `handover-<worker slug>.json` (`HANDOVER_RECORD_STEM`), it goes as its own `artifact` message before the result, the landed name comes from the immediate bus reply to the worker's own `promptobus_send` call, and it is quoted in the **Gate** line after the gate record's — after, so the canonical result's `artifact` field still resolves to the gate record, which is the first claimed name in header order. `review` resolves every `handover-*.json` in the task files folder into absolute paths that reach both the first prompt and the re-review, and `tree` is what tells several of them apart.

**Two preambles of the three carry it, with different duties.** The worker attaches the record (`lib/spawn.js`); the reviewer reads it and names which checks are absent or `notRun` (`lib/review.js`), produces none of its own and does not repeat the checks by hand — it runs nothing. A `mutationProbe` carrying no `expected` is named there too, and it is the one PRESENT check that would otherwise pass in silence: the field is optional, so the cheapest way out of a refusal over it is to delete two lines and send again, and nothing else in the mechanism would hold a trace of that. An optional field is closed on the writing side by the preamble and on the reading side by this, or it is closed on neither. `treeLag` is closed the same way: the worker preamble requires it for an earlier sha from the release that ships the field, and the reviewer preamble names a present one together with both shas and does not take that probe as covering HEAD. The **approver** carries no handover record at all (`lib/approver.js` is unchanged by it): it accepts and merges rather than writing the code, and its own gate run is the integration gate, so a missing handover record under an approver's hand-off is the expected state rather than a gap — the reviewer's prompt says so where the records are resolved. Two copies of one form is the standing risk in this package, and here the copies are deliberately not identical: one role makes the claim and the other reads it.

**The engine does not validate it,** for the same reason it does not validate the gate record: `validate` knows four models and an artifact's bytes are opaque to it. `test/handover-record.test.mjs` asserts the schema by ajv and asserts that `validate` goes on not knowing the name. **`send` checks its SHAPE** by the same door and the same reader the gate record goes through — one mechanism covers both stems, and a record the published schema rejects is refused rather than landed. It also refuses a record that **contradicts itself**, which is the reading past shape it is allowed, each two fields of one document and each needing nothing outside it: `expected` against `reddened`, `baseTotal − passed − reddened.length` against the stated `unaccounted`, and `checks.mutationProbe.tree` against `tree`. A difference of those two shas passes only when `treeLag` says why. What `send` does not do, and must not, is run or grade the checks themselves: **running them is the participant's, and judging them is the reviewer's.** A mechanism that ran a worker's tests to grade its handover would be a second runner with a second opinion about a tree it does not own.

## Claim

The orchestrator mailbox is owned by the session that opened the task. Another session gets a copy and a foreign-mailbox header. A call that names no session gets a copy, the owner gate's no-identity line, the sentence that the originals stayed, and that gate's route ([03-cli § ownership](03-cli.md#ownership--the-owner-gate-of-done-stop-and-dismiss)); it does not take the originals and it does not get the foreign-mailbox header. `src/protocol.ts` names the header constants.

`promptobus_mailbox` with `claim: true` rebinds a task's orchestrator mailbox to the calling session. The tool requires the orchestrator address, a session identity and a recorded owner; `claimOwnership` in `lib/store.js` then replaces that owner under the task lock. It does not check whether the previous owner is live. The caller must establish that the previous session has ended before takeover; this is a precondition on the caller, not an enforced liveness gate. No live-owner displacement was measured for this documentation clarification.

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

**A mailbox read lists headers; a body is asked by its id.** `promptobus_mailbox` without `message` takes the unread mail — the move of each reference into history is what marks a message read — and lists one header per message: the heading `### <type> from <name> · address <address> · <time>`, then `message <id> · <N> characters: <first line>`, then the artifact path when the message carries one, and last a line naming the route to a body. The first line is the body's first non-empty line, cut at 120 characters on a word boundary and marked `…` when cut: a `status` is often one long paragraph, and a first line with no bound would carry the whole body back in. `promptobus_mailbox` with `message: <id>` returns that one body from the address's history and marks nothing, so it can be asked again. An id still unread is refused with the route: only the header read marks mail read, and a body read that took mail would be a second door. A session that only peeks — proven foreign, or with no session identity on the orchestrator address — never takes, so an unread body by id comes to it as a copy under the same heading its header read carries. `claim` and `message` in one call are refused by both names. `promptobus_task` and `promptobus status` count unread references and never render a body. The postcard carries a stub per message, never the body ([03-cli](03-cli.md) § Guard and warden).

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

The frozen [legacy store snapshot](../../test/fixtures/promptobus/MANIFEST.md)
is current input to both the [legacy reader test](../../test/promptobus-legacy-fixture.test.mjs)
and the [migration test](../../test/promptobus-migration.test.mjs). Its original
generator and recorded baseline revision are absent from the public repository;
the manifest describes the available provenance and how to maintain this
compatibility input without recapturing it.

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
yields two metadata records and one immutable blob. Retention is separate:
`prune` removes a whole task and its blobs, while `sweep` may remove an
accepted sender's artifact records and file entries during an active task.
Under the publication lock, `blobNamed` keeps the blob if any surviving
metadata record or another hard link still names it; otherwise the sweep
removes it. See [the CLI cleanup contract](03-cli.md#sweepartifacts--the-removals-of-one-piece-under-the-publication-lock).

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

### The role registry

Source: `src/registry.ts`.

One table declares every addressed role and what each carries. It has two layers: the
governance roles the package fixes ([ADR-021](../adr/adr-021-task-tree-and-governance-routes.md),
[ADR-022](../adr/adr-022-user-addressee-and-orchestrator-debt.md),
[ADR-026](../adr/adr-026-teamlead-one-mailbox.md)) and the pipeline steps, each an
instance of one of three step kinds ([ADR-020](../adr/adr-020-role-registry-and-declared-pipeline.md)).

| Entry | Layer, kind | Address | File stem | Package deny list | Floor | Catalog role | Routed | Lift text |
|---|---|---|---|---|---|---|---|---|
| `orchestrator` | governance | `orchestrator` | none; the name is reserved | none | — | — | no | — |
| `teamlead` | governance | `teamlead:<slug>` | `teamlead-<slug>` | none | — | — | no | — |
| `root` | governance | `root:<slug>` | `root-<slug>` | none | — | — | no | — |
| `peer` | governance | `peer:<slug>` | `peer-<slug>` | none | — | — | no | — |
| `reporter` | governance | `reporter` | `reporter` | reviewer writes plus bus send at lift | — | — | no | reporter |
| `user` | governance | `user` | none; the name is reserved | none | — | — | no | — |
| `worker` | step, `edits-tree` | `worker:<slug>` | `<slug>` | none | 5 | `worker` | yes | `worker` |
| `reviewer` | step, `reads-diff` | `reviewer:<slug>` | `reviewer-<slug>` | the harness's write tools; the host classifies MCP writes by kind | 9 | `reviewer` | yes | `reviewer` |
| `approver` | step, `writes-main-tree` | `approver:<slug>` | `approver-<slug>` | none; the host classifies MCP writes by kind | 7 | `approver` | yes | `approver` |

The deny list, floor, catalog role, routing and lift text of a step are its kind's. The
catalog stays rated per kind, so `ROUTED_ROLES` is the catalog roles of the three kinds and
a step adds none.

**The registry is a value, and the host hands it over.** `SHIPPED_REGISTRY` is the table above,
frozen. `withSteps(registry, declared)` returns a new registry with each declared step admitted:
a name in `[a-z][a-z0-9-]{0,31}` and one of the three kinds, refused when it is a governance
name, when it is already admitted as another kind, or when it overlaps the name of any slugged
entry, `worker` included, in the `<name>-` shape — `reviewer-two:x` and `reviewer:two-x`, or
`worker-foo:x` and `worker:foo-x`, would share one participant id (`addrDir`), one mailbox and one
file stem. An admitted step's stem is
`<name>-<slug>` and its fields are its kind's. `registryOf(host)` is `withSteps` over the host's
optional `pipeline()` member ([02-host](02-host.md#what-the-host-must-answer)). Its value also keeps the active step names in declaration order. Address admission and refusal lists use those names, so a shipped step omitted by a declaration is not offered as a recipient. The standalone host
answers it from the `pipeline` key of `promptobus.json` and omits it when the key is absent, so a
host without a declaration hands over the shipped registry
([02-host § The pipeline declaration](02-host.md#the-pipeline-declaration)). It is computed per call,
and the package keeps no table of its own that anything writes into. A declared step is listed after
the shipped ones. A shipped gate left out of a declaration stays in the registry as an inactive
entry, while address admission and refusal lists follow the declaration. Pipeline order is
`pipelineOf(host)`, not the registry's.

**The grammar needs no registry.** `isAddress`, `roleOf` and `addrDir`
admit the slugless names (`orchestrator`, `reporter`, `user`) and `<name>:<slug>` under any other
step-shaped name; `participantFileStem` gives `reporter` a bare sidecar and requires a slug for
other participant files. No regular expression is edited for a step. Which names are known is the
registry's answer (`admitsAddress`), asked by the doors that hold one: the participant record write
(`participantRecord`, the shipped registry unless the caller hands another), the session identity
behind the MCP join and every command (`resolveIdentity`), `promptobus send`, the MCP
`promptobus_send`, and `history --participant`. An undeclared `boss:x` parses and is refused there.

**Who reads which registry.** The host's, through `registryOf(host)`: the package deny list and
the selector for `participantDenyToolsByKind` or legacy `participantDenyTools`
(`lib/review.js`, `lib/approver.js`), the reserved step names (`refuseParticipantPrefix`), the participant records the lifts write, the lift
words — a step is announced with its kind's words, `the reviewer` for a `reads-diff` step —
(`lib/liftoff.js` and the Cursor and Codex drivers), the `models --role` help, and the doors
above with their address lists. The MCP `promptobus_send` description and its `to` schema are built from that same host registry when the server is constructed. The shipped one, for what no declaration changes: `ROUTED_ROLES`,
the default floors and `DEFAULT_ROLE`, the grammar, and the address list of a refusal that has no host. `HostDenyRole` in `src/host.ts` is its type.

**Rights by kind.** A `reads-diff` gate receives the reviewer's snapshot, cwd and package
deny list, including the harness's write tools byte-for-byte. A `writes-main-tree` gate
works in its own worktree of local main, with the owner's worktree attached for reading,
the approver's deny handling, and the direct route with the owner step. The owner step
of kind `edits-tree` edits its worktree. The route uses the active registry for each send;
the single owner and single `writes-main-tree` gate form its only direct step pair.

**What a kind does not carry yet.** Some remaining behaviour compares shipped step names:
the approver lookups over the task record (`approverHere`, `unprovenApproverLine`, and the
approver seat in `lib/review.js`), `readableName` (it drops a shipped step's prefix and
prints any other address whole), the guard's participant prefixes (`lib/guard.js`), the Codex
holder's approval split (`lib/codex-session.js`), the resolver's live workers and reviewer bonus,
the drivers' re-lift routes and parts of `status`'s recovery hints.
`titleFromLines` takes the active `edits-tree` owner from the registry value when assembling
the task title from track titles.

**The parity test.** The schemas are static JSON, so `test/registry.test.mjs` fails when a
model-routing role enum or the overlay example's floors disagree with the shipped registry, and when a role word is spelled as a literal anywhere in `lib/`, `src/` or `scripts/` outside it. It pins the records' generic `by` grammar separately and walks declared steps through send admission, status order and cleanup.

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
`<!-- contract:… -->` keys did not change. Two harness-shaped values do live here:
`TEAMLEAD_HARNESSES`, the harnesses a teamlead lifts on, and `harnessName`, the display
name of each harness id. They describe the bus's own admission rather than one driver's
dictionary, and the command help reads them before any driver is loaded.

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
