# PB-367 · Select local test groups from affected subsystems while retaining full acceptance coverage

- **Order:** 65
- **Scope:** [Contributing](../../guides/contributing.md)
- **Created:** 2026-10-08
- **Dependencies:** none
- **Cost:** —

## Context

The owner requested shorter feedback loops on 2026-10-08 while implementing BB support. Focused tests already run after individual changes, but every acceptance snapshot runs the full suite through the repository gates. Repeated full runs increase turnaround for a change that affects only one subsystem.

Evidence: `package.json` runs the complete suite with `npm test`; `backslop.json` includes that command in the acceptance gates. The BB reviewer change has focused transport and provider-bridge tests, while its full run reports 126 test files. Preserve the distinction between a fast local check and full acceptance evidence.

## Work to do

- Define test groups by subsystem and map production paths to every affected group, including shared transport and protocol dependencies.
- Add a local check command that selects groups from an explicit Git base and reports selected groups, test counts, command exit codes and omitted groups.
- Fall back to the full suite for unmapped paths, runner changes, shared fixtures or an uncertain dependency mapping.
- Retain the complete suite before merge and in CI. Compare selective runs with complete runs on representative changes before accepting the selection map.
- Document the commands and when a focused result suffices for iteration versus when full acceptance is required.

## Out of scope

- No reduced full acceptance or CI coverage, automatic classification of failing tests as unrelated, or implementation during the BB integration work.

## Verification

- Fixtures for path selection include one subsystem, shared code affecting multiple groups, renames, deletions and unmapped paths.
- A deliberately broken dependent test must be selected and fail; mutation probes demonstrate coverage of the dependency mapping.
- Record the complete-suite count and timing alongside selected-group counts and timing on the same commit.
- The default acceptance gates and CI still execute the full suite and propagate nonzero exit codes.
