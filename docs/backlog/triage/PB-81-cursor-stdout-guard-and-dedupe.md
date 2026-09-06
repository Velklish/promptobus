# PB-81 · The Cursor adapter's spawn-and-capture helper is missing the stdout error guard its two sibling copies in the Claude and Codex adapters carry, and the launch/fetch/keychain/verdict logic around it is hand-duplicated three times

- **Scope:** `lib/model-routing/adapter-cursor.js`, `lib/model-routing/adapter-claude.js`, `lib/model-routing/adapter-codex.js`, `lib/model-routing/preflight.js`, `lib/drivers.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`runOut` in `lib/model-routing/adapter-cursor.js:426-478` sets up its child's stdout at line 475:
```
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (e) => finish({ ok: false, missing: e?.code === 'ENOENT' }));
```
with no `child.stdout.on('error', ...)` — unlike its two siblings, which both carry the guard with the same rationale comment: `lib/model-routing/adapter-claude.js:443-444` (`// A stream error is not an adapter failure to report twice ... Unhandled, it would be thrown at the process.` then `child.stdout.on('error', () => {});`) and `lib/model-routing/adapter-codex.js:317-319` (`// A pipe error with no listener is an uncaught exception that takes the whole command down, which is the one thing an adapter may never do;` then `child.stdout.on('error', () => {});`). An unhandled `'error'` event on a Node.js stream throws as an uncaught exception on the whole process, not scoped to the child — exactly the failure both present comments name as forbidden for an adapter, and it is currently reachable through `runOut`'s own stdout stream in the Cursor adapter alone.

The same three files also carry a triplicated set of small helpers: a `SECURITY_BIN = '/usr/bin/security'` constant and a keychain-secret reader in both `adapter-cursor.js:144` and `adapter-claude.js:105`; a `verdict(state, reason, message, extra = {})` factory duplicated in `adapter-claude.js:343` and `adapter-codex.js:74`, plus five more hand-built verdict object literals in `lib/model-routing/preflight.js` (`state: 'unknown'` at lines 59, 76, 88, 109, 134) and one more in `lib/drivers.js:57`; and a clock call that has already drifted between copies — `adapter-cursor.js:639` calls `isoStamp()` (imported from `./cache.js`) while `adapter-claude.js:348`, `adapter-codex.js:79` and `drivers.js:57` all call `new Date().toISOString()` directly for the same `checkedAt` field. `probeCodex` (`adapter-codex.js:289`) remains one function covering the whole lifecycle, unlike the split `probe`/verdict-mapping shape used by the other two adapters.

## Work to do

- Land the missing guard as a one-line fix first, independent of the rest: add `child.stdout.on('error', () => {});` in `runOut` (`lib/model-routing/adapter-cursor.js`, next to the existing `child.stdout.setEncoding('utf8')` / `child.stdout.on('data', ...)` lines), matching the comment and pattern already proven in the other two adapters.
- As a separate consolidation pass: extract one shared spawn-and-capture helper (the timeout/SIGKILL/stdout-error/close dance already commented as identical across `runOut`/`runCapture`-style helpers), one `requestJson(url, { method, headers, body, timeoutMs })`, one `readKeychainSecret(service, { timeoutMs })`, and one `verdict(state, reason, message, extra)` factory that all three adapters and `preflight.js`/`drivers.js` call instead of their own copies — including one call to `isoStamp()` so `checkedAt` stops drifting between `Date.now`-based and cache-based stamps.
- Split `probeCodex` after its `model/list` call into a lifecycle function and a pure `limitVerdict`, matching the shape `adapter-claude.js` and `adapter-cursor.js` already use.
- Update `docs/reference/03-cli.md` if the split changes any function name it currently cites for the availability adapters.

## Out of scope

- Any change to what a probe reports (verdict states, reasons, messages) — this is a code-structure change behind the existing contract, not a behavior change beyond the stdout-error fix.
- Merging the commented 3-line SIGKILL/finish/destroy/unref block into something less explicit — the in-code comments explain why each copy needs to be read on its own next to its neighbor; only the helpers named above are proposed for extraction.

## Verification

- `npm test` passes.
- A unit test (or an addition to an existing model-routing test file) that pipes a stream error into the Cursor adapter's spawned child during a probe and asserts the process does not crash — mirroring how the Claude/Codex adapters are already exercised, if such a test exists for them, or a new minimal one otherwise.
- After the consolidation pass: `grep -rn "SECURITY_BIN\|function verdict(" lib/model-routing/*.js` shows the constant and factory defined once, not per-adapter.
