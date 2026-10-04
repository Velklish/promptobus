# PB-338 · Move private memory-service policy out of the product test harness

- **Scope:** [Contributing](../../guides/contributing.md)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 40
- **Taken:** 2026-10-04

## Context

At `6f4e9a3`, the product test harness implements a consumer's private memory-service policy. `test/hygiene.mjs:51-56,116-122` explains and hardcodes that service's environment prefix. `applyHygiene` deletes variables under that prefix at `:283-290`. `test/runner.test.mjs:257,295,437-438` injects and verifies the corresponding private stop-gate variable. `test/hygiene.mjs:38-56` also describes the consumer's sync and memory-hook implementation as product-harness behavior.

This is an implementation dependency, not just fixture naming. These test files are not in the npm tarball, but they still violate the source boundary. Removing the filtering blindly could expose live developer state.

## Work to do

- Keep generic hermetic process setup and protection of Promptobus/harness identity in the product suite.
- Move the named memory-service filtering policy and its integration checks to the consumer that configures that service.
- If needed, replace product-side private-name filtering with a neutral environment isolation contract and synthetic fixture names.
- Remove descriptions that attribute another project's sync/hook behavior to this package.

## Out of scope

- Disabling environment isolation or allowing tests to contact live hooks/state.
- Moving generic process cleanup and harness identity protections out of Promptobus.
- Merely renaming the private namespace while retaining the same hidden contract.

## Verification

- Product test infrastructure contains no hardcoded private memory-service namespace or assumptions about the consumer's implementation.
- Generic regression tests prove ambient variables cannot redirect tests into live user state.
- Consumer integration tests own the service-specific filtering assertion.
- Record commands, exit codes, test counts and tested commit; run applicable gates.
