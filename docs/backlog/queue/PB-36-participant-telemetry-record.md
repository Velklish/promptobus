# PB-36 · A telemetry record per routed participant at done: tuple, strategy, duration, review rounds, window deltas — local, no prompts

- **Order:** 55
- **Scope:** `lib/done.js` (or wherever `promptobus done` closes a task), new `lib/model-routing/telemetry.js`, new `schemas/model-routing/telemetry.schema.json`, [03-cli](../../reference/03-cli.md), [02-host](../../reference/02-host.md)
- **Created:** 2026-09-06, owner's decision 2026-09-06
- **Dependencies:** PB-24 (snapshot v2 on `main`), PB-30 (`metadata.routing` carries the decision; `strategySource` from PB-32 when present)

## Context

The catalog's ratings come from published benchmarks (PB-29), and the owner saw their limit at once: two frontier models a point apart on one leaderboard share a band, and nothing in the tool learns from what actually happens on this machine. The owner's decision (2026-09-06): **start collecting local statistics now**, in 0.4.0, so that the data accumulates from the first day; the reading of it — a finer scale, absolute bands, `models calibrate` proposing overlay corrections — is the next series (PB-37, deferred until the 0.4.0 tag).

What the bus already knows about a routed participant: its `metadata.routing` (strategy, tuple, score, snapshot age, warnings — PB-21; `strategySource` — PB-32), the task journal (`history/`, `inbox/`, per-address message files with types and timestamps), the availability snapshot in the cache with every window's `usedPercent` at probe time. What it does not keep is a record that ties them together per participant when the work is over.

## Work to do

- **One record per routed participant, appended at `promptobus done`** (and at `dismiss` if the task stays open — decide which and say why; `done` is the minimum), JSON Lines, in the account-scoped routing directory next to the cache: `<routingPaths().cache's directory>/telemetry.jsonl`, mode `0600`. A participant without `metadata.routing` (legacy path, explicit `--model`) gets a record too, with `strategy: null`, so explicit choices are measured alongside routed ones.
- **Fields** (fix them in `telemetry.schema.json`, additive-only from here on): `schemaVersion`, `recordedAt`, `task` (an opaque hash of the task id, not the id), `role`, `harness`, `model`, `effort`, `tuple` (id or null), `strategy`, `strategySource`, `spawnedAt`, `endedAt`, `durationSec`, `turns` (messages the participant sent), `reviewRounds` (`review` messages it received), `questions` (it asked), `resultCount`, `windows`: for each window that applied to the tuple at spawn time (from the decision's `harnesses` block or the snapshot the decision recorded) — `{ id, kind, scope, usedPercentAtSpawn, usedPercentAtEnd }` with the end value read from the current cache when it is fresh enough, else `null`; `dismissedBeforeDone` (boolean). **No prompt text, no message bodies, no repository path or name, no session id, no email.** The record must pass the same publicity rule as the cache: an opaque local identifier is the only identifier.
- **`quotaCost` evidence is the point of the window deltas**: a positive `usedPercentAtEnd − usedPercentAtSpawn` on the tuple's binding window is the spend of that run in the account's own unit; several participants of one account overlap in time, so the delta is attributed to the run, not to one participant — say so in the record (`concurrentParticipants` on the same harness at spawn) and in the reference; the calibrate pass (PB-37) decides how to divide it.
- **`models` prints one line**: how many records the file holds and its size; no analysis here (PB-37).
- **Host contract**: no new method — the file lives beside the cache the host already names; document in [02-host](../../reference/02-host.md) that a consumer that moves the cache moves the telemetry with it, and that the file is the account's, not one workspace's.
- Reference: the record's fields, when it is written, what it never holds, the size growth (one line per participant), and how to clear it (`rm`; the tool never rotates it in v1).

## Out of scope

- Reading the records back for ratings, a finer scale, absolute bands, `models calibrate` — PB-37.
- Any network call; any field with free text from the harness.

## Verification

- `npm test`: a task with two routed participants and one explicit-model participant closed by `done` appends three records that validate against the schema; a record holds no message body, path, session id or email (a fixture with a token-like string in a message body proves it does not travel); the window delta is `null` when the cache is stale; `models` prints the count.
- Mutation probe after the commit: write the participant's session id into the record → the privacy test fails.
- `npm run audit`, `backslop lint` green.
