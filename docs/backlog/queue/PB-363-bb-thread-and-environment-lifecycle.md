# PB-363 · Launch and inspect BB participants with one owner for each environment

- **Scope:** [CLI lifecycle](../../reference/03-cli.md), [Drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-08
- **Dependencies:** [PB-364 · Add a local BB plugin entry point with engine-backed tools and authenticated participants](PB-364-bb-plugin-engine-and-participant-binding.md)
- **Cost:** —
- **Order:** 20

## Context

Native creation and removal of worktrees happen outside the Driver. Adding a BB driver to the current registry would still invoke native worktree preparation and cleanup. BB thread/environment lifecycle therefore needs its own orchestration path. The current synchronous inspection snapshot cannot directly contain asynchronous SDK results.

Evidence: Source snapshot `9a2a758209802e0b9632aad958f862d15e2e4c30`: `lib/spawn.js:1793-1821`, `:1923`, `lib/sweep.js:198-243`, `src/driver.ts:612-635`. BB SDK 0.6.15 `bundled-types/bb-plugin-sdk.d.ts:4465` describes environment selection and `:16965` the async threads API. The analysis probe reproduced a Promise entering the synchronous snapshot when inspect was async.

## Work to do

- Implement BB spawn/get/stop through the SDK, with explicit parent/lifecycle ownership and durable participant references.
- Create or reuse BB environments through supported environment selection. Store returned actual path, branch, host/environment IDs and base snapshot SHA.
- Define one lifecycle owner: existing native paths keep Promptobus worktree operations; BB-managed environments use BB lifecycle. Prevent native sweep/done from deleting BB-owned resources.
- Fetch async BB state before projecting a synchronous SessionView for shared decision functions; preserve unknown/offline, running, idle and stopping distinctions.
- Confirm runtime stop before cleanup. Preserve required patches/results before archive or environment retirement; do not infer done/acceptance from stop or archive.
- Document lifecycle and retention behavior using captured BB behavior rather than reconstructed native worktree names.

## Out of scope

- No conversion of every existing Driver and supervisor API to async.
- No second worktree owner, automatic archival before preservation, or takeover of native cleanup semantics.

## Verification

- A worker launches in the selected BB environment, records actual metadata and produces a result without native worktree creation/deletion.
- Async observations never leak Promises into decision snapshots; offline/unknown observations are not reported as alive.
- Stop completion, stopping state, archive/retirement and preservation are exercised against BB; cleanup does not lose unaccepted changes or artifacts.
- Native spawn/sweep/done behavior and regression suites remain unchanged.
