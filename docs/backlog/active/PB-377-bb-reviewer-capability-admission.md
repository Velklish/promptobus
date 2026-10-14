# PB-377 · Admit constrained BB reviewers by effective capabilities instead of Codex version

- **Scope:** [BB reviewer compatibility proof](../../reference/02-host.md#bb-reviewer-compatibility-proof)
- **Created:** 2026-10-14
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 230
- **Taken:** 2026-10-14

## Context

The installed Codex CLI reports 0.162.1 while the optional BB reviewer admits only 0.162.0-alpha.17.2. Initialization refuses before review starts. A consumer asked to remove exact and maximum version admission rather than repin on every CLI update. The effective restrictions remain the admission contract.

## Work to do

- Remove numeric version admission from the reviewer transport and retained proof.
- Keep private home, disabled features, empty MCP, read-only sandbox, disabled network, approval policy, model, effort and thread identity checks before any model turn.
- Verify version-independent fixture admission and refusals, then measure the installed CLI and matching plugin payload.
- Document current capability admission separately from historical runtime measurements.

## Out of scope

- Native driver/schema version policy and other providers.
- Global CLI replacement, package release, remote push or unrelated pending tasks.

## Verification

- Reproduce the admission refusal twice with deterministic fixtures, restore success after the fix and run a committed mutation probe.
- Run configured gates with exact command results; retain baseline comparisons for any refusal.
- Run the no-model startup proof, native permission proof and installed BB reviewer workflow separately.
