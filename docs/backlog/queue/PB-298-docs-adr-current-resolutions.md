# PB-298 · Expose current resolutions and supersession in accepted architecture decisions

- **Order:** 480
- **Scope:** [05-drivers](../../reference/05-drivers.md), [Documentation index](../../README.md)
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

Accepted ADRs still present several resolved capability and ownership restrictions as open/current. Historical evidence must remain historical, but the reader needs an explicit path to the implemented contract.

## Evidence

- At b3d4a387, ADR-008:122-128 says a Codex reviewer has no reporting channel until an open blocker is fixed. lib/codex-session.js:641-647,746-754 implements the tool-call elicitation whitelist; CHANGELOG.md:903 records the fix.

- ADR-007:144 says Stop was not observed and approver was not covered. CHANGELOG.md:119-123 records worker/reviewer Stop on Codex 0.156.1; ADR-024:33 records approver SessionStart. These observations differ and must not be promoted into an unmeasured approver Stop claim.

- ADR-013:71-73 says only Claude lifts approver and names 11 Claude-only tuples. ADR-024:27 changes that contract; all three driver capabilities allow approver (driver-claude.js:732, driver-cursor.js:764, driver-codex.js:1209); the catalog has 43 approver tuples.

- ADR-016:189-193 retains fail-open ownership prose. ADR-017:83-121 replaces it; lib/store.js:936-945 refuses missing identity.

- ADR-011:107-116 says NOT unblocked/no command, while its :90-103 amendment and lib/cli.js:375 establish the implemented command; docs/README.md:28 indexes only the withdrawn decision. ADR-019:31-32 describes the identity card and ADR-011 amendment as future work, despite ADR-014:71-87 and the existing amendment.

## Work to do

- Add explicit current resolutions or partial-supersession pointers for ADR-007/008/011/013/016/019 and align the index.
- Preserve dated old measurements as old evidence; avoid rewriting them as results of the latest build.
- Use self-contained contract/ADR links, not task cards, for the resolution.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- A reader entering through any listed ADR can distinguish the historical decision, current permission rule and actual harness capability.
- No accepted current paragraph instructs fail-open ownership or Claude-only approver against the current implementation.
- Verify the updated index still covers every ADR; no new live test is claimed without a run.
