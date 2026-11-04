# ADR-041: Versioned BB plugin release collection

**Status:** Accepted
**Date:** 2026-11-04
**Deciders:** Project owner

## Context

The BB adapter builds immutable generations, while the native panel has ordinary
server/app/Host entries. Installed path sources can remain in participant
worktrees or sandbox directories after their source is accepted elsewhere.
Those paths do not track compatible releases through BB's update mechanism.
BB Git installs disable lifecycle scripts and rebuild declared entries into
`dist`; the adapter's source descriptor has no installable entries.

Flattening the core into a Host bundle also changes `import.meta.url` origins.
Package-relative provenance, service runtime fingerprints and command resources
must continue to refer to the captured core after its checkout is removed.

## Options

A permanent local checkout preserves development generations but still requires
manual source selection, build and installation. A registry release would need
an additional publication channel. A Git artifact collection can reuse the
repository's authenticated release channel and BB's semver-tag update support.

Committing raw source descriptors would depend on lifecycle scripts BB does not
run. Committing only `dist` would lose the bundle when BB rebuilds it. Keeping
captured bundles in a separate input directory allows the normal builder to
recompile wrappers while retaining the adapter's frozen source identity.

## Decision

Build a separate two-plugin artifact collection from the accepted source commit.
Store its inputs in `bundle`, expose ordinary server/Host/app wrapper entries,
index the packages in `.bb/plugins.json`, and publish annotated `bb/vX.Y.Z` tags
on the artifact branch. Record source revision and file hashes in `release.json`.
Both packages use the same release version and tested BB/SDK profile.

The adapter Host embeds its exact public core package in the build. It extracts
and verifies those bytes under the daemon plugin data directory before importing
root admission. Package-relative service identity and resource reads then use
that retained package, not the Host bundle's relocated directory. Core import
without standalone Host creation performs no package-provenance read.

Command modules retain a collection-local core dependency. The panel Host remains
a self-contained observer. Its background server service owns explicit BB owner
notification binding and durable delivery correlation.

## Consequences

Normal Git range installs and `bb plugin update` select compatible plugin
releases independently from the core package. Development generations remain
available for local work. Release production includes two builds, source/asset
provenance and an install/update qualification; publishing a source tag alone
is insufficient. Tags are immutable.

The embedded core increases Host artifact size and retains one content-addressed
runtime package in daemon data. Every materialization verifies its complete
captured file set and refuses tampering. It executes only package code from the
approved plugin build; task paths and participant claims select no runtime code.
Older bindings are not migrated. Live role, provider and lifecycle qualification
remains separate from portable-bundle and SDK fixtures.
