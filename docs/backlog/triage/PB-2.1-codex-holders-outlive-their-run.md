# PB-2.1 · Codex holder and stub app-server processes outlive the run that started them

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none

## Context

Finding discovered while working on PB-2, on the machine of the routing run.

Twelve processes from a suite run of **2026-09-04** were still alive on 2026-09-05 at 12:46 UTC, and were still alive at 13:52 after nine further full runs — six `lib/codex-hold.js` and six stub `codex.stub.mjs app-server --stdio`. Their argv names the run that left them: a consumer worktree `…-tracks2-consumer-t20260904-151959`, and session records under a temporary home directory that no longer exists. Consumer paths are elided below — this repository's publicity audit forbids the origin's names — and what is kept is what a reader needs: the pids, the program, and the session file each holder is holding.

```text
2714 node <consumer worktree>/node_modules/promptobus/lib/codex-hold.js
       <gone tmp home>/.promptobus/codex/sessions/worker-driver-codex-0903-0000-5e068957b0ac.json
7080 …/codex-hold.js …/sessions/review-driver-codex-0903-0000-0934a587b450.json
7416 …/codex-hold.js …/sessions/worker-driver-codex-0903-0000-apr-de621c9f1d09.json
7804 …/codex-hold.js …/sessions/worker-driver-codex-0903-0000-die-4b824e45d184.json
8206 …/codex-hold.js …/sessions/worker-driver-codex-0903-0000-slow-2cd6a21d8513.json
8498 …/codex-hold.js …/sessions/worker-driver-codex-0903-0000-mcp-78e512c5f310.json
2718 node <gone tmp stand>/bin/codex.stub.mjs app-server --stdio
7081 7417 7805 8207 8521 — the same, five more
```

This is the sibling of PB-2, not of PB-14.4. PB-14.4 is about a run READING processes it does not own; this is about a run LEAVING processes nobody reaps. The two met on the same check — `promptobus-driver-codex.test.mjs`, "after a lift refusal there are no holder processes" — but the scoping fix does not touch this one: the snapshot-and-subtract (`beforeHold` / `beforeApp`) filters these leftovers out by construction, and they were left alive on purpose through nine full runs to exercise exactly that. The runs stayed green and left nothing new, so the filter works.

What the class costs: the same rule the warden auto-lift gate exists for — "a bus command must not start a process that outlives the run" (the gate at the tail of [test/run.mjs](../../../test/run.mjs)) — is enforced for wardens and not for holders. Six node processes per leak, holding a socket each, on a developer machine, indefinitely.

What is verified: the pids, their argv, that the directories their session files name are gone, and that they survived from 2026-09-04 to 2026-09-05 13:52 UTC across nine full suite runs. What is NOT verified: which exit path left them — a run cut off at a file timeout, a Ctrl-C, or a normal run whose cleanup missed. `armCleanup` in [test/harness-codex.mjs](../../../test/harness-codex.mjs) kills `holderPid` and `appPid` from every session record on `exit` and on the three signals, so the record was already gone or unreadable when it ran, or the process was taken down without either.

## Work to do

- Establish the exit path first, by reproduction rather than by reading: run the Codex file, take it down at each of the three points (SIGKILL of the runner, file timeout, crash inside a check), and see which leaves holders.
- Then decide where the reap belongs. Two candidates, and they are not equivalent: the stand's `armCleanup`, which knows the session records but not a process it never recorded; and a run-level gate like the warden trace — a holder start writes a line, the tail of the run refuses if any of them is still alive.
- A sweep at the START of a run, next to the `$TMPDIR` sandbox sweep, is the third option and the only one that helps with what is already on this machine. It needs the same care as the sweep: a holder of a run GOING nearby must not be killed, and the argv carries a session file path that says which run owns it.

## Out of scope

- The scoping of the process reads themselves — that is PB-14.4, and it is done.
- The live harness scripts. They start real holders on purpose.

## Verification

- A run taken down at each of the three points leaves no `codex-hold.js` and no stub app-server behind.
- The twelve processes named above are killed by hand as part of closing this — they predate any fix and no gate will reach them.
