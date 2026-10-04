# PB-339 · Provide supported host integration and diagnostic contracts

- **Scope:** [Host contract](../../reference/02-host.md)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 30
- **Taken:** 2026-10-04

## Context

At `6f4e9a3`, `package.json:35-57` exposes the package root, driver, host, telemetry, hooks, CLI and schemas. It does not expose internal lib paths or an installation API. `src/host-index.ts:2-10` exports host contracts and standalone construction, not installation/diagnostic operations. Meanwhile `lib/install.js:23-43,55,67,94,103,120,260,481,705,709` exports module-local helpers that a consumer can reach only by depending on package layout.

The paired consumer audit found file-URL imports that bypass package exports; its direct subpath import probe returned ERR_PACKAGE_PATH_NOT_EXPORTED. That probe belongs to the paired audit and was not repeated here. Consumers need a supported integration boundary instead of reproducing package internals.

## Work to do

- Inventory the concrete installation, diagnostics and host-integration operations the consumer currently obtains from private modules.
- Assign each operation to the existing public API/CLI where possible; add only missing, focused supported contracts.
- Document inputs, outputs, compatibility and ownership, then coordinate the consumer migration to those contracts.
- Keep private helper/module structure private; publish only the required stable surface.

## Out of scope

- Exporting all of lib or making internal file paths a supported interface.
- Encoding one consumer's organization, repository layout or policy in the API.
- Duplicating existing public operations under new names.

## Verification

- Tests install the built tarball in a separate fixture and exercise each agreed consumer operation through supported package exports or CLI.
- The paired consumer migration no longer imports private package paths or bypasses exports through file URLs.
- An unsupported internal import remains unsupported unless deliberately included in the reviewed contract.
- Record the operation inventory, commands, exits, counts and tested commit; run applicable gates.
