# PB-149 · The Cursor adapter's runOut leaves child.stdout unguarded against an error event, so an unhandled stream error would crash the routed command instead of yielding a verdict

- **Order:** 500
- **Scope:** `lib/model-routing/adapter-cursor.js`, `lib/model-routing/adapter-claude.js`, `lib/model-routing/adapter-codex.js`, [reference/03-cli.md](../../reference/03-cli.md) § Availability: the adapter, the preflight and the cache
- **Created:** 2026-09-06
- **Dependencies:** PB-58

## Context

`runOut` (lib/model-routing/adapter-cursor.js:426-478) is the Cursor availability adapter's spawn helper: it backs the keychain-bearer read (line 499) and the two `cursor-agent status` / `models` probes (lines 684 and 696) that `cursorAvailability` runs during preflight. It spawns at line 434 with `stdio: ['ignore', 'pipe', 'ignore'], shell: false` and wires the pipe at lines 474-477:

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (e) => finish({ ok: false, missing: e?.code === 'ENOENT' }));
    child.on('close', (status) => finish({ ok: true, status, out }));

The `error` listener sits on `child`, not on `child.stdout` — nothing listens on the stream itself.

The two sibling adapters guard the identical spawn shape and state the reason in comments. adapter-claude.js:397 spawns with the same `stdio: ['ignore', 'pipe', 'ignore']` and adds at lines 442-444: "A stream error is not an adapter failure to report twice: `close` follows and carries the outcome. Unhandled, it would be thrown at the process." — followed immediately by `child.stdout.on('error', () => {});`. adapter-codex.js:315-319 gives the same reason for its own pipes: "A pipe error with no listener is an uncaught exception that takes the whole command down, which is the one thing an adapter may never do."

`grep -rn "uncaughtException\|process.on(" lib/ src/ bin/` returns nothing, confirmed just now — there is no process-wide net, so an `'error'` on the unguarded stream in adapter-cursor.js would propagate as an uncaught exception and end the routed `spawn`/`review`/`models` command outright, mid-preflight, rather than yield the `probe_failed` verdict the adapter contract promises.

The emission itself stays unforced on this path: a probe replaying the timeout branch (`/bin/sh -c 'yes hello'`, then `kill('SIGKILL')` + `child.stdout.destroy()` + `unref()` while roughly 111 MB had streamed) produced `close` with no `'error'` — a no-argument `destroy()` emits nothing, and an ENOENT from a missing binary reaches the already-handled `child`-level listener at line 476. Neither of the two triggers the sibling comments name fires on that path; only a read-side pipe failure would. The repo has already measured that class of failure as unforceable: docs/archive/PB-17-codex-availability-adapter/result.md records "the one green probe is the pipe `'error'` listeners — measured on Node 25.2.1, a failed spawn and a write after exit raise no uncaught exception, so nothing can pin them; they stay." So this is a confirmed inconsistency with an invariant the repo states twice in words, not a crash anyone has reproduced live — worth closing, but small.

## Work to do

- Add `child.stdout.on('error', () => {});` at lib/model-routing/adapter-cursor.js:474, beside the `setEncoding` call, with the same one-line comment the Claude adapter carries: the listener needs no body because `close` already carries the outcome — it exists only so the stream cannot throw at the process.
- Add one sentence to docs/reference/03-cli.md § "Availability: the adapter, the preflight and the cache" stating that every adapter guards its own child pipes, so the invariant is written once in the reference instead of living only in two of the three inline comments.
- CHANGELOG entry under `[Unreleased]` noting the Cursor adapter now guards `stdout` like its Claude and Codex siblings.

## Out of scope

- Reproducing the stream `'error'` emission on this adapter — PB-17 already measured the same class of guard as unforceable on Node 25.2.1, so no test is proposed for it.
- Any change to adapter-claude.js or adapter-codex.js — their guards are already correct and unchanged.
- The kill/`destroy`/`unref` timeout handling in `runOut` — untouched and unrelated to the missing listener.

## Verification

- `grep -n "child.stdout.on('error'" lib/model-routing/adapter-cursor.js` shows the new listener at the same spot the two sibling adapters have theirs.
- `npm test` stays green — nothing in test/model-routing-adapter-cursor.test.mjs asserts the listener's absence.
- Diff review confirms the listener body is empty with the explanatory comment, matching adapter-claude.js's pattern exactly.

## Triage — 2026-09-07

- **Track:** R — Routing policy, overlays and availability.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/model-routing/adapter-cursor.js:426`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
