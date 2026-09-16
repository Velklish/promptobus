# PB-206.3 · Binding a unix socket is EPERM in the Codex participant sandbox, and suite files abort on it

- **Order:** 70
- **Scope:** `test/check.mjs`, `test/run.mjs`, `test/runner.test.mjs`, `test/sandbox.mjs`; socket groups in `test/promptobus-{guard,e2e,mixed,warden,harness,driver-codex}.test.mjs`, `test/tmpdir-sweep.test.mjs` and `test/scenario.mjs`; `lib/driver-codex.js` (sandbox writable roots); adjacent — [PB-194](../../backlog/deferred/PB-194-worktree-drops-out-of-sandbox-writable-roots.md)
- **Created:** 2026-09-12, from a Codex worker's baseline in run opt0912
- **Dependencies:** none

## Context

The first three observed files of the suite never reached their assertions inside a participant sandbox: the test harness could not bind a unix socket under `/tmp`.

`test/promptobus-guard.test.mjs` aborts after four verdicts. The setup it cannot complete:

```js
orchLive.once('error', rej);
orchLive.listen(ORCH_SOCK, res);
```

The complete error:

```text
Error: listen EPERM: operation not permitted /tmp/ags-dOIrvY/orch.sock
    at Server.setupListenHandle [as _listen2] (node:net:1918:21)
    at listenInCluster (node:net:1997:12)
    at Server.listen (node:net:2119:5)
    at store.writeWake.socket (test/promptobus-guard.test.mjs:111:12)
code: 'EPERM', errno: -1, syscall: 'listen', port: -1
```

`test/promptobus-e2e.test.mjs` and `test/promptobus-mixed.test.mjs` return the same `EPERM` from `test/scenario.mjs:317` on `/tmp/…/orchestrator.sock`. Each of the three was run twice back to back; the exit code of the `node --test` command was 1 every time, at load averages between 8 and 18 — far below the 115…198 of [PB-159.1](../../backlog/queue/PB-159.1-pooled-load-reds-beyond-preflight.md).

**The abort point is not stable, and an earlier draft of this card claimed it was.** The same `test/promptobus-guard.test.mjs`, in the same sandbox and on the same unchanged tree, stopped after 4 verdicts of 68 at 20:16 and reached 58 of 68 at 20:28. The file is red either way and the refusal is the same `EPERM`, but how far a run gets before hitting it varies. What decides that — which temporary directory the run draws, how many sockets are already bound — is unmeasured, and the work must not assume a fixed failure point.

> Source: 2026-09-12, run opt0912, worker `pb-role` in a Codex sandbox; `node --test test/<file> > log; echo $?`, twice per file. Full guard log in the task artifacts of that run.

One boundary is worth stating rather than assuming: the full-suite runner reached these socket points and failed **later** in those three files. The direct per-file invocations are stable, but they are not equivalent to the full-suite runs, and the assert set the full suite failed on is therefore not established for these three. The worker did not label those unseen assertions as matching, and neither does this card.

**Control 2026-09-12, a participant sandbox of another harness.** A Claude participant lifted by `spawn` into a worktree of this same repository ran the full suite within the same hour on the same machine: `npm test` exit 0, 64 of 64 files, `promptobus-guard.test.mjs` 68/68 in 7.2 s, **zero EPERM**. The refusal therefore belongs to the **Codex** participant sandbox and not to participant sandboxes as such — which also means the socket path the tests use is acceptable everywhere else, and the decision below is about what a Codex participant may write to rather than about moving the socket for everyone.

Later measurement expanded the same class to seven files: guard, E2E, mixed-harness, warden, tmpdir sweep, the harness stand and the Codex-driver integration. The last one fails on the production holder's fallback path under Darwin's system temp (`/var/folders/…/pb-cdx-*.sock`), not under `/tmp`. Two minimal controls also fail with `listen EPERM` inside the already writable canonical `/private/tmp`, using both an absolute socket path and a path relative to that directory. Moving the socket or adding another writable directory therefore cannot repair this sandbox: the denied operation is unix-socket `bind`, independent of which measured writable temp root holds the path.

`test/tmpdir-sweep.test.mjs` exposes the adjacent boundary separately. From this worker's non-writable worktree cwd it aborts first on a relative `mkdtemp`; from writable `/private/tmp` it reaches 34 of 35 assertions and then gets the same socket `EPERM`. That first refusal remains [PB-194](../../backlog/deferred/PB-194-worktree-drops-out-of-sandbox-writable-roots.md), not evidence about sockets. The Codex launch plan now names `cwd` explicitly among `runtimeWorkspaceRoots` for every participant role instead of relying on an implicit working-directory grant; the reviewer still receives its reviewed tree through the same field because its actual working directory is the private review sandbox.

## Decision

- A shared `listenTestSocket` classifies only a `listen` error with code `EACCES` or `EPERM` as an unavailable capability. Those two measured permission refusals produce `{ok: false, reason}`. Any other error rejects and keeps the file red.
- A socket-dependent group calls the shared `skip` verdict when that capability is unavailable. The group is named and the original refusal is printed. Independent assertions in the same file continue; the harness and Codex-driver files preflight before starting their live child processes.
- A skip is not a pass. Per-file summaries report passed and skipped counts separately. The runner lists every skipped check and file, and its last summary names every file in which zero real checks passed. A failed check followed by a skip still exits 1 and reports both outcomes.
- The runner self-test for an ordinary failed verdict sets its own exit code before reporting through `check`. This bootstrap keeps a mutation of `check` from silencing the assertion that is meant to detect it.
- On a host where `listen` succeeds, no skip branch is taken. The socket-dependent assertions remain unchanged and run in full.

## Out of scope

- The identity contamination that reddens dismiss, mcp, review and spawn — PB-206.2.
- Changing what the tests assert: the subject here is where they put their socket, not what they check.

## Checks

- Each of the seven files reaches a complete verdict inside the Codex participant sandbox: unaffected assertions pass and every unavailable socket group is a named skip rather than an abort.
- Both measured permission codes are classified as unavailable; a synthetic `EINVAL` remains an error. A mutation that makes the classifier swallow an ordinary error must turn the suite red.
- One child emits a failed verdict and then a skip; its mixed summary stays red. Mutations that disable the failed-verdict exit code or let `skip` clear it must turn the runner self-test red through its independent bootstrap.
- The runner's green and red paths both name fully skipped files as `0 checks passed`; a completely skipped E2E file cannot hide inside a file-count success.
- A full run outside the participant restrictions is unchanged. On the implementation tree, `npm test` exits 0 with `65/65 test files passed` and no runtime skip.
- The merged-tree, outside-sandbox control is the approver's check; it must also contain zero skips.
