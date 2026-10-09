# PB-352 · OpenCode holder tests abort on denied localhost binding instead of reporting named skips

- **Order:** 79
- **Scope:** [05. Drivers — OPENCODE](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** none
- **Cost:** major

## Context

The new socket-dependent holder checks call server.listen directly without listen refusal handling. Source-confirmed: test/promptobus-driver-opencode.test.mjs:287 and :458; shared supported helper test/sandbox.mjs:260-274; README.md:264 promises listen EACCES/EPERM produce named skips, while other errors remain failures. On bind denial, an unhandled Server error aborts the file before later pure checks. Isolated reviewer result 20261006T135900047-0005-51d017.

Evidence: 2026-10-06, source re-read at HEAD a64dd37af65b395585d06324bd79bd73b122198e. Normal root driver run was 65/65 exit 0; bind-denial execution has not been reproduced in preflight and remains required as a deterministic injected-error test. This card records the source-confirmed missing contract branch, not an environmental failure of that green run.

## Work to do

- [ ] Use the shared refusal-aware listener helper with suitable TCP listen options at both socket sites; verify its supported call shape rather than assuming that a Unix socket path is a TCP endpoint.
- [ ] Name only socket-dependent checks as skipped on EACCES/EPERM; preserve pure checks and fail other errors.
- [ ] Add deterministic bind-denial regression coverage and update contributing notes if needed.

## Out of scope

- Weakening socket checks for arbitrary failures.

## Verification

- [ ] Injected EACCES/EPERM produces explicit named skipped checks and a completed file.
- [ ] Pure checks still run, another listener error stays red, normal run remains green.

## Triage

2026-10-09: queue after the cleanup-completion fix as a bounded test-harness correction. Current source `ea81f0d8643d923aecf140b813ae9ae521270d23`, `test/promptobus-driver-opencode.test.mjs:287,458`, retains direct listeners without the refusal handling in `test/sandbox.mjs:260-274`; the public named-skip contract is in `README.md:274`. Source inspection confirms the missing branch, not an observed bind refusal during this triage. Begin with injected EACCES/EPERM and a different error; name skipped socket checks separately and keep pure checks executing. No blanket suite skip is acceptable.
