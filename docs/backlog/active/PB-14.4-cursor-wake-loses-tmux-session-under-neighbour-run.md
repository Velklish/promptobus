# PB-14.4 · HYPOTHESIS: `promptobus-cursor-wake.test.mjs` loses its session when another run is on the machine

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none
- **Taken:** 2026-09-05

## Context

Observed once, during the PB-14 gate run on 2026-09-05 at 10:58 UTC. `npm test` came back `1 of 40 files failed`; the file was `promptobus-cursor-wake.test.mjs`, 8 of 16 checks, all of them downstream of the same diagnosis:

```text
persist session cursor-promptobus-wake-…-a8dc7b is not on the tmux server cursor-agent
— it was stopped from outside or the machine rebooted (persist state lives in /tmp)
```

The same file run alone immediately afterwards was 16/16. Nothing in the PB-14 diff reaches the Cursor wake path — the change is `src/model-routing.ts`, `lib/model-routing/*`, `lib/drivers.js` (one new function), and docs — so the failure is not this task's, and it is filed rather than chased.

**The mechanism is a hypothesis, and the reason it is worth recording is that it would hit every parallel worker run, not this one file.** `lib/cursor-persist.js` line 67 sets `TMUX_TMPDIR = '/tmp'` as a literal, and line 53 names the server `cursor-agent`. That pair is machine-wide: the suite's TMPDIR diversion ([test/hygiene.mjs](../../../test/hygiene.mjs)) does not reach it, because the library overrides the variable for the tmux child. Two `npm test` runs on one machine — which is the normal state of a worker run by tracks, each track in its own worktree — therefore put their stand-in sessions on ONE tmux server, and a human's own Cursor persist sessions sit there too (`lib/driver-cursor.js` line 849 says so in as many words).

What is verified: the literal `/tmp`, the shared server name, the observed failure text, and that a solo re-run is green. What is not: that a neighbouring run is what removed the session. Nobody watched the other run at that minute, and the failure has not been reproduced on purpose.

## Work to do

- Reproduce deliberately: two `npm test` runs started a few seconds apart on one machine, and see whether the file fails in one of them. If it does not reproduce in three attempts, close this — a single unexplained failure with a green re-run is not worth a permanent entry.
- If it does reproduce, the cheap fix is a server name unique per run for the suite only — the stand harness already knows its sandbox — leaving the production name alone, since a person's own `cursor-agent` server is the point of that name.

## Out of scope

- The production `TMUX_TMPDIR = '/tmp'` and the `cursor-agent` name. They are deliberate: the driver shares a server with the person's own sessions on purpose.
- Making the file serial. It already is (`SERIAL` in [test/run.mjs](../../../test/run.mjs)); serial within one run does not separate two runs.

## Verification

- Two concurrent full runs, both green, repeated three times.
- The stand harness still cleans up after itself: no `cursor-agent` session survives a run, and `tmux -L cursor-agent list-sessions` reports no server when nothing else is using one.

## Confirmation from the orchestrator (2026-09-05)

The catalog track's worker ran `npm test` in the background from 10:50:01 UTC (its status message) until its result at 10:57:34 UTC, on the same machine — exactly the window of the failed first gate run here. Two suites on one machine sharing the tmux server `cursor-agent` is therefore observed, not only hypothesised; what remains unverified is the mechanism by which one run removes the other's session.

## Second member of the family (2026-09-05, Cursor adapter track)

`promptobus-driver-codex.test.mjs`, check "after a lift refusal there are no holder processes — hold <pid> · app <pid>", went red on a full run at about 11:43 UTC while the Codex adapter track was running its own suite on the same machine; the file alone immediately after was 56/56. The check counts holder and app-server processes machine-wide, so a neighbouring run's pids count against it. Same shape as the tmux case: a process-wide resource read by a suite that assumes it is alone. Whatever fix closes the tmux member should be judged against this one too (a run-scoped marker on the processes, or a per-run tmux server name).

## Merged in at triage (2026-09-05): PB-15.3 and PB-17.1

Both tracks hit the Codex holder check (`promptobus-driver-codex.test.mjs`, machine-wide `pgrep -f 'codex-hold.js'` and `pgrep -f 'app-server --stdio'`) reddened by the neighbouring worktree's suite, with PIDs captured. PB-17.1's fix proposal: scope both patterns to the file's own sandbox — the stub's argv carries its bin directory, the holder's argv its session file. The same pass should cover every `pgrep` in the suite, not one line.
