# PB-98 · Codex driver's `PHRASES.sessions` hardcodes `~/.promptobus/codex/sessions`, which is only the standalone host's answer

- **Scope:** [02-host.md](../../reference/02-host.md), [03-cli](../../reference/03-cli.md) § The Codex holder, `lib/driver-codex.js`, `lib/codex-session.js`, `lib/harness-home.js`
- **Created:** 2026-09-06
- **Dependencies:** none
- **Taken:** 2026-09-10

## Context

lib/driver-codex.js:66 — `sessions: 'participant threads — ~/.promptobus/codex/sessions (overridden by PROMPTOBUS_CODEX_HOME)'`. Re-verified verbatim.

The real registry location comes from `codexStateHome()` (lib/codex-session.js:66-67) via `harnessStateHome()` (lib/harness-home.js:74): `PROMPTOBUS_CODEX_HOME` if set, else the bound host's `harnessStateHome('codex')`, else a `GateError` refusal. The file's own header (lib/harness-home.js:1-19) says the unconditional default under the real home was removed because it *was* the bug (PB-2): a consumer host that named its own variables left the package writing into the operator's real home while `inspect` read the sandbox.

`~/.promptobus/codex` is only what the standalone host answers (src/standalone.ts:182-184: `harnessStateHome: (harness) => path.join(os.homedir(), ROUTING_HOME, harness)`, `ROUTING_HOME = '.promptobus'`). The shipped consumer host answers a different path: consumer-cli' cli/lib/promptobus/ati-host.js:92 resolves to `~/.agents/<harness>`. Measured on this machine: `~/.agents/codex/sessions` holds the live thread records; `~/.promptobus/codex/sessions` does not exist.

The phrase reaches the operator at exactly the moment they are told to close a session by hand: lib/done.js:116, 127, 173, 351 and lib/review.js:647, 674 all interpolate `driver.phrases.sessions` into a warning telling the operator where to look.

Sibling drivers name a command instead of a path — lib/driver-claude.js:253 (`sessions: 'claude agents'`), lib/driver-cursor.js:236 (`sessions: 'agent persist list'`) — neither breaks when the host changes the on-disk location.

No test pins the Codex phrase: only the Cursor one is pinned, test/promptobus-driver-cursor.test.mjs:90-91 (`PHRASES.sessions === 'agent persist list'`).

Not tracked in docs/backlog/{queue,active,deferred,triage} or docs/archive (grepped for `PHRASES.sessions`, "sessions:", "codexStateHome"). docs/reference/02-host.md already documents the correct, host-resolved behaviour (lines 37, 67) — the drift is code-only.

## Work to do

- Turn `sessions` into a value computed from the resolved home rather than a literal path — e.g. a lazy getter calling `sessionsDir()` (lib/codex-session.js:70-72), guarded against the `GateError` `harnessStateHome` throws when no host is bound (since all six call sites are inside warning strings, the catch should fall back to naming the source rather than propagating) — or, if a computed path is judged too heavy for a warning string, replace the literal with a description of the source: "participant threads — the registry the host names for `codex` (`PROMPTOBUS_CODEX_HOME` overrides it)".
- Whichever is chosen, the operator must be able to reach the real directory from the printed line without already knowing which host is bound.
- Add a test in the Codex driver suite mirroring test/promptobus-driver-cursor.test.mjs:90-91, asserting the phrase follows a host that answers a non-default home.
- CHANGELOG.md entry.

## Out of scope

- Changing `harnessStateHome`'s refusal behaviour or its resolution order (env var, then host, then `GateError`) — this task only fixes what the Codex driver prints about it.
- The equivalent phrase on other drivers — `claude` and `cursor` already name a command, not a path, and are unaffected.

## Verification

- New test: a stub host bound with `harnessStateHome('codex')` answering a non-default path — the operator-facing `sessions` phrase reflects that path, not `~/.promptobus/codex/sessions`.
- `npm test` green; `test/promptobus-driver-cursor.test.mjs` unaffected.

## Triage — 2026-09-07

- **Track:** C — Codex session lifecycle.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/driver-codex.js:66`, `lib/codex-session.js:66`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
