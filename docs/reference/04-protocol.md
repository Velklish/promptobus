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

`task`, `status`, `question`, `answer`, `artifact`, `result`, `review` (`MESSAGE_TYPES`).

`artifactPath` on send is an absolute file path. The file is copied into the task store. The message stores the artifact name.

## Engine

`openEngine({ root, policy })` or `openEngine({ home, policy })`. Exactly one of `root` / `home`. `policy` is required at open: a callback `{ allow: true } | { deny: true, reason }` per sender/recipient pair.

The engine does not wake anyone. It returns activation events. The warden and the driver wake the session.

Mail is kept until read. Read is a rename from `inbox/` to `history/`. There is no exactly-once processing after that.

## Artifacts

An artifact is attached to a send. There is no separate upload command. Blobs are content-addressed (`blobs/<sha256>`) and immutable inside one task. A digest mismatch on read is `artifact-integrity`.

## Claim

The orchestrator mailbox is owned by the session that opened the task. Another session gets a copy and a foreign-mailbox header. `promptobus_mailbox` with `claim: true` takes ownership when the previous session is gone. `src/protocol.ts` names the header constants.
