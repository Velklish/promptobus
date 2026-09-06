# PB-69 · The PATH prepend in `live-e2e.mjs` and `live-canary.mjs` is dead — `resolveToolBin` hands back a bare name, so `path.dirname()` is `.` and the current directory lands first on the PATH of the run and of every live session it spawns

- **Scope:** `scripts/live-e2e.mjs`, `scripts/live-canary.mjs`, `test/sandbox.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

test/sandbox.mjs:187-192 defines `resolveToolBin`: it runs `spawnSync(name, ['--version'], …)` on the bare `name` and, when that succeeds, returns `{ ok: true, path: name, bin: name, version }`. It resolves nothing — the only way `spawnSync(name, …)` can succeed is if `name` is already reachable through PATH, and the `path` field it returns is that same bare name, never a location on disk.

scripts/live-e2e.mjs:41-53 calls it and then acts as if it had resolved something: `const tool = resolveToolBin('claude')` (line 45), `const binDir = path.dirname(tool.path)` (line 50), then prepends `binDir` onto `process.env.PATH` when it isn't already present (lines 51-53). The comment above the block claims the opposite of what the code can do: "The binary is found with the same resolve spawn uses — including `~/.local/bin`" (line 41). scripts/live-canary.mjs:199-224 repeats the identical shape — resolve, `path.dirname`, prepend, at lines 219-222 — under a comment making the same claim: "It cannot be called through PATH: the Claude Code install does not put itself there" (lines 199-201).

Probe re-run just now (scratchpad, `node` as the stand-in binary):
```
resolve: {"ok":true,"path":"node","bin":"node"}
binDir: "."
includes: false
new PATH: .:/usr/bin:/bin
```
`path.dirname("node")` is `.`, and prepending it onto `/usr/bin:/bin` puts the current directory first.

The prepend propagates rather than sitting inert. test/scenario.mjs:497-498 builds `orchEnv` as `{ ...process.env, … }`, and the worker session is lifted with `spawnSync(BIN, [...,'--worker','e2e',...wh.flags], { cwd: ws, env: orchEnv })` (scenario.mjs:577) — `.` in PATH resolves against the sandbox worktree `ws`, so a file named `git`, `node` or `claude` written there by a live session would shadow the real binary for every child of that run. live-canary.mjs recomputes `childEnv()` on every call by design (comment at lines 188-192: "It is computed on EVERY call, not once at file load"), so the same PATH reaches `sync`, `doctor` and every other CLI invocation the canary makes.

The branch is dead by origin, not by design: `git log -L 44,53:scripts/live-e2e.mjs` shows it arrived whole with the transferred integration suite (418477f) and was only translated to English afterwards (4eb7093), never re-derived against this host's `resolveToolBin`. test/promptobus-spawn.test.mjs:725-728 already documents why it stopped doing anything here: "Origin ATI host walked ~/.local/bin. Dest resolveToolBin returns { ok, bin: name } and does not look at HOME." The three live scripts written after the transfer call the same helper as a plain presence gate and prepend nothing: live-cursor.mjs:56, live-codex.mjs:44, live-mixed.mjs:71.

Not tracked: grep over docs/backlog/{queue,deferred} and docs/archive for `live-e2e`, `live-canary` or `binDir` finds nothing.

## Work to do

- Drop the PATH prepend in both scripts (live-e2e.mjs:50-53, live-canary.mjs:219-222). A successful `resolveToolBin` already proves the binary answers through PATH, so the block has nothing left to add — what it does add is the current directory. This converges on the shape live-cursor.mjs, live-codex.mjs and live-mixed.mjs already use: resolve as a presence gate, PATH untouched.
- Rewrite the two comments in the same pass (live-e2e.mjs:41-44, live-canary.mjs:199-201): say that the helper searches nothing and `ok` means the binary is already on PATH; drop the `~/.local/bin` claim, which belongs to the origin ATI host — the reason it no longer applies is already recorded at test/promptobus-spawn.test.mjs:726.
- Alternative, larger option: give test/sandbox.mjs's `resolveToolBin` the shape `findAstGrep` (test/sandbox.mjs:198-211) already has — PATH first, then named install prefixes — and return an absolute path. Then the prepend has something real to prepend and the comments become true.
- Pick one of the two options, not both, and name the choice made.

## Out of scope

- The host contract's own `resolveToolBin` (`src/host.ts` `HostToolBin`, `src/standalone.ts`) and its lack of a version probe under the standalone host — that is separate, already-covered ground (PB-15.1, PB-16.2, both archived), not this test-only helper in test/sandbox.mjs.
- Any change to how `bgSessions` or the session registry itself resolves `claude` — it already goes through PATH unmodified and is not touched by this fix.

## Verification

- `grep -n binDir scripts/live-e2e.mjs scripts/live-canary.mjs` returns nothing after the fix (or, if the install-prefix option is chosen, `resolveToolBin` returns an absolute path and the prepend uses it correctly).
- `grep -n 'local/bin' scripts/live-e2e.mjs scripts/live-canary.mjs` returns nothing — the rewritten comments no longer make the `~/.local/bin` claim.
- A live-canary or live-e2e run still finds and drives `claude` normally, and the PATH printed at the start of the run no longer starts with `.`.
