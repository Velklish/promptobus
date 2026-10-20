# PB-385 · Define and enforce send and close ordering

- **Order:** 320
- **Scope:** [Protocol and storage](../../reference/04-protocol.md), asynchronous artifact publication and task closure
- **Created:** 2026-10-20
- **Dependencies:** none
- **Cost:** major

## Context

At source `5386bd5d6dedd84dd69760cfee4f1c0f19543f87`, an isolated deterministic audit held an artifact stream after send admission, called `closeTask`, then released the stream. The task remained `done`, but send resolved successfully and added one unread message and its artifact after closure. No provider or global resource was used. This is a current-core observation, not an attribution of a previous live-run incident.

Evidence: `src/v1/engine.ts` asynchronous `send` calls `requireActive` before awaiting the stream and commits without rechecking. The audit diagnostic recorded `statusBeforeCommit=done`, `unreadBeforeCommit=0`, `statusAfterCommit=done`, `unreadAfterCommit=1`, `sendResolved=true`, exit 0. It asserts observed overlap; its success is not product acceptance. Original command, output and compiled-source provenance are retained in the audit sidecar.

Independent review found that `docs/reference/04-protocol.md` promises activity validation before the first side effect, while `test/v1-engine.test.mjs` covers a send started after closure. Neither explicitly forbids completion of an already admitted send. Classify this as a contract decision, not a proven regression. Existing recovery of previously committed fan-out on a done task must remain valid.

Priority: before BB lifecycle acceptance. Impact: callers need a defined terminal ordering boundary; historical frequency and token cost are notMeasured.

## Work to do

- Agree whether closure drains already admitted sends or fences their uncommitted publication. The recovery plan recommends a terminal barrier: already committed fan-out may recover, uncommitted sends may not publish after close.
- Enforce the selected contract using the existing storage transaction mechanism. Do not add a global machine lock.
- Return a typed terminal-state result for rejected publication and handle staged artifacts. If drain is selected instead, expose the draining state explicitly before terminal completion.
- Preserve recoverable fan-out and already committed correspondence.

## Out of scope

- Changes to provider permissions, global process discovery, or old run artifacts.
- Claiming that this fixture proves the cause of a historical hang.

## Verification

- Hold an artifact stream at an explicit barrier, close the task, release the barrier: no successful message commit may appear after the committed terminal boundary.
- Cover synchronous send, failed/interrupted artifact staging, fan-out recovery and repeated close. No arbitrary sleeps or timeout inflation.
- Verify task, journal, artifact and mailbox consistency, including after reopening the engine.
- Run focused core checks and independent review on the final source; run BB lifecycle acceptance separately after its plan is approved.
