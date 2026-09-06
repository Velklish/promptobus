# PB-116 · The codex `initialize` handshake (clientInfo + capabilities) is built independently in codex-session.js and adapter-codex.js — the probe hardcodes clientInfo.version as '0.0.0' instead of reusing the holder's hostClientInfo()

- **Scope:** `lib/codex-session.js` (`hostClientInfo`, `packageIdentity`), `lib/model-routing/adapter-codex.js`, [03-cli](../../reference/03-cli.md) § Codex availability, § The Codex holder
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Verified at commit `cc1aca8` (v0.5.0).

Holder (`lib/codex-session.js:914-920`):
```
const init = await rpc.request('initialize', {
  clientInfo: hostClientInfo(record, env),
  capabilities: {
    experimentalApi: true,
    optOutNotificationMethods: ['mcpServer/startupStatus/updated'],
  },
}, INIT_TIMEOUT_MS);
```
`hostClientInfo` (line 51) falls through `record.hostName`/`hostVersion`, then `env.PROMPTOBUS_HOST_NAME`/`_VERSION`, then `packageIdentity()` (line 39), which reads the real version out of `package.json` — currently `0.5.0`.

Probe (`lib/model-routing/adapter-codex.js:357-362`):
```
const init = await ask('initialize', INIT_TIMEOUT_MS, {
  clientInfo: { name: 'promptobus', version: '0.0.0' },
  capabilities: {
    experimentalApi: true,
    optOutNotificationMethods: ['mcpServer/startupStatus/updated'],
  },
});
```
The `capabilities` object is byte-identical between the two files; only `clientInfo` differs, and only because the probe hardcodes it rather than calling `hostClientInfo`. Neither `hostClientInfo` nor `packageIdentity` is exported from `codex-session.js` (`grep -n "^export" lib/codex-session.js` lists no such export), and `adapter-codex.js:47-49`'s import list (`INIT_TIMEOUT_MS, MODEL_LIST_TIMEOUT_MS, limitWaitMs, listedModels, rateLimitReached`) does not include it — so the two objects are hand-copied, not shared.

`docs/reference/03-cli.md:424` states the project's own rule for this pair of code paths, about the neighbouring rate-limit gate: "What they share is the reading of the protocol — `rateLimitReached` and `listedModels` — not a copy of it." The `initialize` params are pure request-construction data with no reason to differ between probe and holder, so this is the one place that rule was not followed. This is a diagnostic/support gap, not a functional bug: the probe's connection is closed right after the checks, so nothing downstream consumes the wrong version except app-server's own logs.

## Work to do

- Export `hostClientInfo` (or a small `codexInitParams(record, env)` wrapping `clientInfo` + `capabilities`) from `lib/codex-session.js`.
- Call it from the holder with the real `record`, and from the probe in `adapter-codex.js` with `record = null` (the probe predates any session record, so it falls through to `env` override or `packageIdentity()` — the true package version — instead of the literal `'0.0.0'`).
- Note in `docs/reference/03-cli.md`'s Codex availability section that the `initialize` handshake, unlike the rate-limit requests, is shared rather than duplicated.

## Out of scope

- The rate-limit request duplication itself (`rateLimitReached`, `listedModels`) — already deliberately shared at the reading layer, not the request layer.
- Any change to the contents of the `capabilities` object — it is already identical in both files.

## Verification

- Existing Codex adapter and holder tests stay green.
- Manual check: run the probe against a stub app-server and confirm the `initialize` request it sends now carries `version: '0.5.0'` (or the current `package.json` version) instead of `'0.0.0'`.
