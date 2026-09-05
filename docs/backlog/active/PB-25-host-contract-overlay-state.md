# PB-25 · Host contract: the workspace overlay is state — its path and the writable layer

- **Scope:** `src/host.ts`, `lib/model-routing/catalog.js`, [02-host](../../reference/02-host.md), [ADR-002](../../adr/adr-002-standalone-host-contract.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-23
- **Taken:** 2026-09-06

## Context

`routingPaths()` (ADR-003, "Host contract") returns the cache path and an ordered list of overlay layers; standalone names `user` at `~/.promptobus/model-routing.json` and `workspace` at `<workspaceRoot>/model-routing.local.json`. ADR-004 decision 6 makes the workspace overlay state: its content is written by the tool (`models strategy --set`, PB-32) and changes over time, so it does not belong in the repository root next to files people commit, and exactly one layer must be the one the tool writes.

## Work to do

- `HostRoutingPaths`: a layer gains `writable?: boolean`; the contract requires exactly one writable layer when any layer is declared, and `readLayers` refuses two. `dist/host.d.ts` follows, and the consumer-facing check in the reference names the new field (the first consumer's suite compares the declaration).
- Standalone host: the `workspace` layer moves to `<promptobusHome>/model-routing.json` and is the writable one; `user` stays under the user home and is read-only for the tool. Document that a consumer may keep the layer wherever its own state lives, as long as it is not a committed file.
- `models validate` prints which layer is writable.
- [02-host](../../reference/02-host.md) and ADR-004: the reason — a file the tool rewrites cannot live where a person's edits and a repository's `.gitignore` are the contract.

## Out of scope

- Writing the overlay (`models strategy --set`) — PB-32.
- Migrating an existing `model-routing.local.json`: the old path is no longer read; the release note says so.

## Verification

- `npm test`: standalone `routingPaths()` names the new path and the writable flag; two writable layers refused with the layer names; `dist/host.d.ts` matches the source.
- `npm run audit`, `backslop lint` green.
