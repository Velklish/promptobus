# PB-350 · Delegated lifts retain the OpenCode parent contact, password and config environment

- **Scope:** [05. Drivers — OPENCODE](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 70
- **Taken:** 2026-10-06

## Context

The shared parent environment drop list omits OpenCode record/config/password variables, so delegated lifts retain the parent's contact and credentials. Source: lib/session-env.js:3-10, lib/driver-common.js:27-30, lib/driver-opencode.js:82 and :167-170. The parent fixture in test/session-env.test.mjs:48-50 derives only from the old list and misses these names.

Evidence: 2026-10-06, HEAD a64dd37af65b395585d06324bd79bd73b122198e, `node /Users/kim.p/AtiWorkspace/workspace/.promptobus/tasks/codex-backlogs-t20261006-134126/files/repro-opencode-boundaries.mjs` → exit 0. Filtering an environment with synthetic values retains all four names: PROMPTOBUS_OPENCODE_SESSION, OPENCODE_SERVER_PASSWORD, OPENCODE_CONFIG, OPENCODE_CONFIG_DIR. No real credentials or model turn used. Isolated reviewer result 20261006T135900047-0005-51d017 independently confirms the source path; live exploitation not measured.

Additional owning-source evidence: installed OpenCode 2.0.20 bundled executable shell-launch code sets `S.env.OPENCODE_SESSION_ID=g.sessionID` from the same session id used in command metadata. Static binary/source inspection on 2026-10-06, no model turn. The isolation scope includes dropping this inherited identity even while root-ownership admission remains a separate unresolved decision.

## Work to do

- [ ] Strip OpenCode parent contact/config/password state and OPENCODE_SESSION_ID for every delegated harness; preserve the child's own newly generated values.
- [ ] Add explicit synthetic OpenCode parent keys to cross-harness isolation tests instead of deriving the fixture solely from the implementation list.
- [ ] Update environment-isolation reference and shipped process instructions.

## Out of scope

- Changing model routing or owner identity.

## Verification

- [ ] Child plans contain no synthetic parent state for every supported driver; own child state remains valid.
- [ ] New regression checks fail on the current implementation and pass after the fix.
