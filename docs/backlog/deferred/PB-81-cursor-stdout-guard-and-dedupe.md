# PB-81 · Consolidate duplicated availability adapter helpers after focused correctness fixes

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

- PB-149 owns the stdout guard; do not implement or accept that defect a second time here.
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

## Deferred

- **Deferred:** 2026-09-07
- **Reason:** The pipe failure has its own focused fix in PB-149; sharing adapter lifecycle, HTTP and keychain helpers is a separate structural change.
- **Return condition:** PB-149 and routing correctness changes are accepted, and a bounded extraction brief identifies equal contracts and regression cases.

## Triage — 2026-09-07

- **Track:** X — Deferred structural work.
- **Priority:** P3.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/model-routing/adapter-cursor.js:426`, `lib/model-routing/adapter-claude.js:443`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** The missing Cursor stdout guard is owned solely by PB-149. This deferred task contains only the optional shared-helper consolidation, after adapter correctness has stabilized.
