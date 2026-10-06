# PB-349 · An HTTP exception during OpenCode lift bypasses holder cleanup before registry registration

- **Scope:** [05. Drivers — OPENCODE](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** none
- **Cost:** major

## Context

The OpenCode lift defines a cleanup helper that reaps the holder and deletes its record/log, but calls createSession and sendPrompt outside a try/catch. A rejected HTTP request propagates directly, bypassing that helper. Registry registration occurs only after both requests succeed, so ref-only stop cannot find the partial holder from its normal registry entry.

Evidence: 2026-10-06, Promptobus HEAD 450f0d265553fac9973d5db74917195b03291cd9, source inspection. `lib/driver-opencode.js:289-298` defines fail; `lib/driver-opencode.js:306-316` awaits createSession/sendPrompt before writeSession without a rejection handler. `lib/opencode-session.js:29` awaits fetch and its finally does not turn a rejected request into a result. Reviewer checkpoint 20261006T135436117-0003-bcf3f0 independently confirms the path. HTTP-exception holder reproduction remains a required implementation red probe; no live OpenCode model turn was performed.

## Work to do

- [ ] Ensure every exception after holder start follows cleanup exactly once, preserving the original failure.
- [ ] Cover connection rejection during session creation and first prompt with a stub holder; verify holder, record, log and registry state.
- [ ] Update the failure-cleanup contract and document the measured behavior.

## Out of scope

- OpenCode owner identity, model routing and other harness launch behavior.

## Verification

- [ ] Stub-server transport failures reject the lift and leave no live holder, partial record/log or stale registry entry.
- [ ] New regression probe fails on old code and passes on fixed code.
- [ ] Successful lift and ordinary non-200 failure behavior remain covered.
