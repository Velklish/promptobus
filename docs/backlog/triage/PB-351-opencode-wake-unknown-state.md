# PB-351 · OpenCode wake posts another turn when the preceding turn state is unreadable

- **Scope:** [05. Drivers — OPENCODE](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** none
- **Cost:** major

## Context

activate reads the holder message tail but does not validate response status/shape. Missing data is treated as length zero, bypassing the busy refusal, so a subsequent successful POST reports wake success without proven idle state. Source: lib/driver-opencode.js:498-504; documented idle-only contract docs/reference/05-drivers.md:732-735.

Evidence: 2026-10-06, HEAD a64dd37af65b395585d06324bd79bd73b122198e, `node /Users/kim.p/AtiWorkspace/workspace/.promptobus/tasks/codex-backlogs-t20261006-134126/files/repro-opencode-boundaries.mjs` → exit 0. Synthetic GET HTTP 500 error body and GET HTTP 200 malformed JSON both yield one prompt POST and outcome ok:true. fetch was mocked, no network or model turn performed. Reviewer result 20261006T135900047-0005-51d017 confirms the same branch.

## Work to do

- [ ] Require valid, proven idle state before posting; unknown/error/malformed state returns ok:false for retry.
- [ ] Cover 500, malformed JSON, accepted array envelopes, busy and idle responses.
- [ ] Update measured wake behavior in driver reference.

## Out of scope

- Other harness wake semantics and model routing.

## Verification

- [ ] Unknown/busy state produces no prompt POST; proven idle state produces exactly one.
- [ ] Regression probe fails on current code and passes on fixed code.
