# PB-152 · The Codex session record carries the caller's whole environment as `childEnv` for the participant's whole life, though the detached holder reads it exactly once, at spawn

- **Scope:** `lib/driver-codex.js` (`spawn`, `sessionEnv`, `SESSION_ENV_DROP`), `lib/codex-session.js` (`writeJson`, `holdMain`, `startHolder`), [reference/03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

driver-codex.js:417 `childEnv: sessionEnv(env ?? process.env)` copies the whole calling environment into the session record written at `spawn` (driver-codex.js:390-421). `sessionEnv` (driver-codex.js:110-114) drops exactly one name, `CODEX_HOME` (`SESSION_ENV_DROP = ['CODEX_HOME']`, line 49) — everything else the caller's shell exported travels through unfiltered. `grep -rn childEnv lib/ src/ test/` finds exactly two hits: this write, and the one read, `env: record.childEnv ?? env` inside `holdMain` (codex-session.js:672), which fires once, when the detached holder spawns `codex app-server --stdio`. Nothing reads `childEnv` off the record again after that.

The record file is written `0600` (`writeJson`, codex-session.js:106-112), but the directory it lives in is created with the default mask: `mkdirSync(path.dirname(file), { recursive: true })` at codex-session.js:107 carries no `mode`, and live on this machine `~/.promptobus/codex/sessions` is `drwxr-xr-x`. The record — and the environment inside it — is removed only by `dropSession` (codex-session.js:132-136), called from `stop`/`done`; nothing removes it earlier. So for the whole life of a Codex participant, whatever the operator's shell held at spawn time — API keys, tokens, anything else exported — sits in a file the holder needed for one read, in a world-listable directory.

The sibling harness solves the same class of problem out of band. `startHolder` (codex-session.js:323-331) already spawns the holder with `env: { ...env, PROMPTOBUS_CODEX_HOME }` — a near-superset of the very environment `childEnv` duplicates — so `holdMain`'s own `record.childEnv ?? env` fallback would already have an equivalent environment available without the record carrying it at all. `cursor-persist.js` takes the sidecar route for the same kind of data: its launch script is written `0700` (line 474) and unlinked on both the success path (line 507) and the lift-failure path (line 485), so the materialised environment never outlives the moment it is needed.

## Work to do

- Stop writing the full environment into the durable record. Either drop `childEnv` from the object written at driver-codex.js:417 and let `holdMain`'s existing `record.childEnv ?? env` fallback use its own inherited environment (moving the `CODEX_HOME` drop to wherever that inherited env is assembled, mirroring what `sessionEnv` does today) — or, if a spawn-time snapshot must be explicit, write it to a `0600` sidecar file that `holdMain` reads once and unlinks right after spawning `app-server`, on both the success and the lift-failure path, following the `cursor-persist.js` launch-script pattern (lines 474/485/507).
- Create `~/.promptobus/codex/sessions` (and any other directory `codex-session.js` creates via a bare `mkdirSync`) with an explicit `0700`, so the directory listing itself does not name active participants to other local accounts.
- Add a test asserting that a written Codex session record (or its sidecar, for the second option) no longer carries the environment once the holder has confirmed `app-server` is up — or, for the drop-the-field option, that the record written at spawn has no `childEnv` key at all.

## Out of scope

- Narrowing `SESSION_ENV_DROP` to an explicit allowlist of variables the child actually needs (PATH, HOME, `PROMPTOBUS_*`, the MCP env) — that changes what the child is allowed to see, a separate and larger question from how long the record keeps a copy.
- `startHolder`'s own `env` argument, which is never persisted to disk and reads directly from the live parent process.

## Verification

- After a Codex `spawn`, the on-disk session record (or its sidecar) no longer contains `childEnv` once the holder has confirmed the app-server is up.
- `ls -ld ~/.promptobus/codex/sessions` shows `drwx------`.
