# ADR-027: The host integration entry point

**Status:** Accepted
**Date:** 2026-10-04
**Deciders:** the owner, who named the entry point `promptobus/integration` on 2026-10-04; the rest is recorded from the shipped entry point.

## Context

A product that embeds the bus needs more from the package than the protocol. It quotes values the CLI prints in its own help and documentation, reads the shipped drivers' vocabulary — effort levels, permission modes, the tools a read-only participant loses — renders the hook and skill install itself, diagnoses routing readiness, passes commands through to the package CLI, and checks the installed version against its pin.

The `exports` map offered none of that. Its keys were `.`, `./driver`, `./host`, `./telemetry`, `./hooks`, `./cli` and `./schemas/*`, and `import('promptobus/lib/install.js')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. An embedding product audited on 2026-10-04 therefore built file URLs from the installed package directory into eight `lib/` modules, read the installed `package.json` directly, and kept a hand copy of the command list. Every file the package moved or split could break that product, and no release would have said so.

[ADR-002](adr-002-standalone-host-contract.md) decides how the bus learns the workspace: a host passed on every call. This record decides a different question: which part of the package a host may import.

## Options

- **A. Export `lib/*` as a pattern key.** The cheapest change. Every module under `lib/` and every name it exports becomes public surface, so no internal module could be moved, split or renamed without a contract change. Rejected.
- **B. Leave hosts on file-URL reads.** No change in the package. The coupling stays invisible: a release that moves a file breaks a host that pinned it, and no changelog entry names the break. Rejected.
- **C. Serve everything through the CLI, `runPromptobus`.** No new import surface. The install plan, the driver declarations and the routing report have no command that prints them as data; each would need a machine-readable output mode whose only reader is an embedding product, and the values would be scraped from printed text. Rejected.
- **D. One focused entry point that lists the names a host needs, and `COMMANDS` on the existing `./cli`.** The `exports` map stays the whole supported surface, and internal modules stay free to change behind it.

## Decision

D. The entry point is `promptobus/integration` (`lib/integration.js`, with its types in `lib/integration.d.ts`); the owner chose the name.

- **The `exports` map is the supported surface.** Nothing under `lib/` or `dist/` is reachable except through one of its keys, and the package test holds a set of private paths unexported.
- **One new entry point rather than a wider map.** It holds the installed version, the values the CLI prints, the driver declarations, the install targets and plan, and the routing readiness report. A name already public elsewhere is not repeated: the bus server name stays `BUS_SERVER` of `./hooks`, and running a command stays `runPromptobus` of `./cli`, which also exports `COMMANDS`.
- **Compatibility is by name and shape.** Removing a name, or changing the shape of what a name returns, is a contract change and its changelog entry says so. Adding a field to a returned object is not.
- **Ownership is split.** The package owns the values, the driver declarations, the install targets, the install plan and the routing reading. The host owns what it decides: which harnesses and commands it offers, its workspace paths, its manifest, applying a plan, and the wording of a diagnosis for its users.
- **Driver declarations are data.** `DRIVER_DECLARATIONS` is a deep-frozen copy of each shipped driver's `id`, `capabilities` and `options`. No driver method crosses the boundary, so a driver's methods can change without a contract change; the one diagnostic a host runs, the wake-channel smoke, is its own name, `checkWake`.
- **A host's tests and scripts that import internals stay unsupported.** Each such call site moves to a public name or a command, or stays bound to one release's file layout.

## Consequences

- A new need of an embedding product is met by a name added to this entry point, with its row in [02-host § The host integration entry point](../reference/02-host.md#the-host-integration-entry-point) and a verdict in the package test's consumer fixture, not by a new file URL.
- Internal modules can be moved and split freely while the entry point's names and shapes hold. The package test installs the packed tarball and exercises each name through public specifiers only.
- Removing or reshaping a name costs a contract-change entry and a repin in every embedding product.
- The entry point loads the install, driver, status and worktree modules when it is imported; the routing modules load only when `routingDiagnosis` is called.
