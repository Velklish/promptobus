# PB-443 · Investigate seven fixture scheduling dependencies with controlled event ordering

- **Order:** 690
- **Scope:** [CLI reference](../../reference/03-cli.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** major (hypothesis)

## Context

The audit identified seven static scheduling hypotheses in existing tests. It observed no flake and measured no frequency. Each member needs a separate controlled experiment, event-order receipt and disposition before a fix is chosen. A rejected hypothesis can finish with evidence and no change; UNKNOWN remains unresolved. Common fixture work does not collapse these mechanisms into one load or flakiness claim.

This batch was approved in the 2026-11-13 whole-backlog audit at source `51867619447b812a2a03fc80fa5b271490e5756c`. Its original findings remain open until execution and acceptance. Grouping is not evidence that a hypothesis is confirmed or a defect is fixed.

## Work to do

- PB-419.24: control relift/send/knock/guard ordering beyond the fixture's nine-second turn lifetime. If causal, hold the turn at an explicit barrier until knock and ordering assertions finish, then release it with a separate watchdog.
- PB-419.25: delay the second specific holder notification past the fixed observation window. If causal, await both log events with a bounded watchdog that reports the log; preserve independent EPIPE and exit checks.
- PB-419.26: delay the reservation test controller while holding turn B. If causal, release B only after reservation and auth assertions; preserve a negative control that removes reservation while B is held.
- PB-419.27: delay the Stop controller while holding the actual child alive. If causal, assert the first unresolved Stop before releasing the child, then await confirmed exit before recovery; retain idempotency.
- PB-419.28: control scheduler pauses around update, torn-read and deadline behavior. If causal, use suitable deterministic clocks or signals while retaining separate update and timeout assertions, malformed-health retry behavior and a hang watchdog.
- PB-419.29: prove the old holder/contender reached the lock before cleanup resumes, rather than treating a short absence of nativeStarted as exclusion. If causal, add an attempted-lock barrier, preserve no-second-spawn and test an authorized exclusion-removal mutation.
- PB-419.30: delay each of the three server end events beyond 50 ms. If causal, await each payload's end event with a bounded watchdog before parsing; preserve independent JSON/auth/message/no-token/probe-only and negative assertions.
- For every member, record the controlled delay/fault, event order and confirmed/rejected/UNKNOWN result; retain a minimal justified correction or explicit no-change disposition. Release fixture processes and keep production contracts unchanged.

## Acceptance criteria

- Seven separate dispositions retain their own controlled event-order evidence; no static hypothesis is relabeled as an observed flake or assigned an invented frequency.
- PB-419.24, if corrected: a delay beyond nine seconds preserves the intended ordering test, a knock after the guard is still detected, and all processes are released.
- PB-419.25, if corrected: a delayed second notification does not fail prematurely; a missing notification fails within a bounded watchdog with its log. Both notifications, EPIPE and exit checks remain independent.
- PB-419.26, if corrected: a delayed controller retains the reservation/auth assertion window; removing reservation while B is held makes the regression fail; cleanup releases B.
- PB-419.27, if corrected: first Stop remains unresolved while the held child is alive despite controller delay; only confirmed exit allows recovery; idempotency and cleanup remain.
- PB-419.28, if corrected: update, torn-read retry and timeout outcomes remain independently tested; scheduler pauses alone do not change the verdict and hangs remain bounded.
- PB-419.29, if corrected: attempted lock acquisition is proven, both processes clean up, no second native spawn remains asserted, and an authorized exclusion-removal mutation fails.
- PB-419.30, if corrected: delayed server end over 50 ms is handled; missing end fails diagnostically within the bound. All three payloads and independent auth/message/no-token/probe-only/negative checks remain covered.
- Retain original independent assertions and watchdogs. No speculative sleep increase or production-contract weakening substitutes for an event-order proof.

## Out of scope

- Production semantic changes or weakened reservation, ownership, exclusion, auth or Stop contracts.
- Speculative fixes, longer sleeps as a substitute for readiness, stress runs or live workflows without their separate authorization.
- Closing or archiving original hypotheses merely because they share this batch.

## Verification

- Controlled experiments and all post-change commands remain notRun. For each executed experiment retain exact command, source/runtime identity, event-order receipt, outcome and exit code.
- After changes, run `npm run build` and the affected focused files: `node test/claude-relift.test.mjs`, `node test/codex-holder-spawn.test.mjs`, `node test/codex-holder-turn-reservation.test.mjs`, `node test/codex-stop-recovery.test.mjs`, `node test/delivery-wait.test.mjs`, `node test/lead-startup-cleanup-race.test.mjs`, `node test/promptobus-warden.test.mjs`; notRun.
- For actual changed mechanisms, retain separate negative controls and separately authorized committed semantic mutation witnesses, including reservation-removal and exclusion-removal cases, then run the configured final gates with exact commands/counts/exit codes; notRun.
- Stress, mutation and live activity are not authorized by assigning this batch. Obtain the separate authorization required by the original records before those activities; no stress or live workflow is needed to label a static hypothesis.

## Original findings and retained requirements

### PB-419.24 — Investigate relift turn timing dependency

[Complete original finding](../minor/PB-419.24-investigate-relift-turn-timing-dependency.md).

- Run a controlled experiment to establish whether the nine-second relift turn lifetime can change the knock/guard ordering verdict; record event order and either outcome.
- If justified, hold the turn at an explicit barrier until knock and ordering are checked, then release it with a separate watchdog. A delay beyond nine seconds must keep the intended test meaningful, and a knock after the guard must still be detected. Release all processes.
- If rejected, retain evidence and make no speculative behavior change. After any change run `npm run build` and `node test/claude-relift.test.mjs`; notRun. Stress/mutation/live require separate authorization.

### PB-419.25 — Investigate holder notification timing dependency

[Complete original finding](../minor/PB-419.25-investigate-holder-notification-timing-dependency.md).

- Run a controlled experiment delaying stdout/log processing and the second holder notification to confirm or reject the fixed observation-window hypothesis; record event order and outcome.
- If justified, await both specific log events with a bounded watchdog. A delayed second notification must not fail prematurely; a missing notification must fail within the bound and report the log. Preserve independent EPIPE and exit checks.
- If rejected, retain evidence and make no speculative change. After any change run `npm run build` and `node test/codex-holder-spawn.test.mjs`; notRun. Stress/mutation/live require separate authorization.

### PB-419.26 — Investigate reservation assertion timing window

[Complete original finding](../minor/PB-419.26-investigate-reservation-assertion-timing-window.md).

- Run a controlled experiment on turn B's fixed release window and delayed controller; record event order and whether reservation/auth assertions lose their intended pre-turn window.
- If justified, hold B until reservation and auth assertions finish, then release and clean up. A delayed controller must retain the assertion window; removing reservation while B is held must fail the regression under separately authorized mutation.
- If rejected, retain evidence and make no speculative change. After any change run `npm run build` and `node test/codex-holder-turn-reservation.test.mjs`; notRun. Stress/mutation/live require separate authorization.

### PB-419.27 — Investigate stop recovery holder lifetime

[Complete original finding](../minor/PB-419.27-investigate-stop-recovery-holder-lifetime.md).

- Run a controlled experiment on the short-lived holder and delayed first Stop controller; record event order and confirm or reject verdict dependence.
- If justified, hold the child until first unresolved Stop is asserted, then signal exit and await confirmed exit before recovery. First Stop must remain unresolved under controller delay, recovery requires confirmed exit, and idempotency is preserved. Release the fixture child.
- If rejected, retain evidence and make no speculative change. After any change run `npm run build` and `node test/codex-stop-recovery.test.mjs`; notRun. Stress/mutation/live require separate authorization.

### PB-419.28 — Investigate delivery wait wall-clock bounds

[Complete original finding](../minor/PB-419.28-investigate-delivery-wait-wall-clock-bounds.md).

- Run a controlled experiment on the elapsed-time assertions and scheduler pauses; record event order and confirm or reject verdict dependence.
- If justified, investigate deterministic clocks or signals for update and deadline behavior. Independently preserve update, torn-read/malformed-health retry and timeout outcomes; scheduler pauses alone must not change the verdict and hangs remain bounded by a watchdog.
- If rejected, retain evidence and make no speculative change. After any change run `npm run build` and `node test/delivery-wait.test.mjs`; notRun. Stress/mutation/live require separate authorization.

### PB-419.29 — Investigate cleanup race test scheduling window

[Complete original finding](../minor/PB-419.29-investigate-cleanup-race-test-scheduling-window.md).

- Run a controlled experiment to determine whether no nativeStarted within the observation window can pass before the contender reaches the lock; record event order and outcome.
- If justified, prove attempted lock acquisition with a barrier before cleanup resumes. Preserve no-second-spawn, clean up both processes, and require a separately authorized exclusion-removal mutation to fail.
- If rejected, retain evidence and make no speculative change. After any change run `npm run build` and `node test/lead-startup-cleanup-race.test.mjs`; notRun. Stress/mutation/live require separate authorization.

### PB-419.30 — Investigate socket receive timing dependency

[Complete original finding](../minor/PB-419.30-investigate-socket-receive-timing-dependency.md).

- Run a controlled experiment delaying server end/payload storage to confirm or reject premature parsing after a fixed 50 ms wait; record event order and outcome.
- If justified, await each of the three server end events with a bounded watchdog. A delay over 50 ms must be handled; missing end must fail diagnostically. Preserve JSON and negative checks and independent auth, message, no-token and probe-only assertions.
- If rejected, retain evidence and make no speculative change. After any change run `npm run build` and `node test/promptobus-warden.test.mjs`; notRun. Stress/mutation/live require separate authorization.

## Next step

Execute this bounded batch in queue order, preserving the separate decision or evidence prerequisites above. Native/account probes retain their own explicit boundaries; queue placement itself grants none.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
