# ADR-006: Guard hook ownership by command signature

**Status:** Accepted
**Date:** 2026-09-09
**Deciders:** Павел Ким (owner), on the PB-52 checkpoint of the 2026-09-09b run

## Context

The installer writes guard hooks into project settings with absolute node and
binary paths. The install manifest that stores exact hook ids lives under
`.promptobus/`, which is machine-local state and is not present in a fresh
checkout. Without a manifest id, matching the current machine's command leaves
a copied guard from another machine in place and installs a duplicate.

The guard hook has a stable rendered shape even when those paths change: two
quoted launch elements, optional bare host-prefix words, the bare `guard`
subcommand, and either no flags or the identity triple
`--role <value> --task <value> --home <value>`. PB-52's regression reproduces
the duplicate after rewriting both paths and deleting `.promptobus/`, then
verifies that uninstall removes the copied guard.

## Decision

Guard ownership uses the rendered command signature as its portable fallback.
`isOwnedGroup` checks the exact ids from `prevIds` (and the ids generated for
the current install) first. If no exact id matches, a guard-event command is
owned only when it matches the rendered shape above. The path values of the
first two elements are deliberately not part of the signature. The manifest
stays under `.promptobus/`; no committed manifest is added.

## Rejected alternative

A manifest committed beside `promptobus.json` would carry ownership across
machines, but it would turn machine-local install state into a project file and
would require the installer to maintain a file users could commit. The owner
chose the portable signature instead. A substring test such as `promptobus
guard` was also rejected because it would claim unrelated commands that merely
contain those words.

## Consequences

- A guard copied from another checkout is replaced by install and removed by
  uninstall even when the manifest is absent or has no matching id.
- Any `Stop`/`SessionStart` command (Cursor `stop`) with the accepted shape is
  treated as ours regardless of the binary or paths it launches. This bounded
  false-positive class is intentional; commands outside the shape remain
  foreign.
- Future changes to `guardHookCommand` must update the signature, its tests,
  `docs/guides/install.md`, and this ADR together. The exact `prevIds` check
  remains the first ownership path.
