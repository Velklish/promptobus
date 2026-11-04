# BB plugin delivery

The adapter and native dashboard ship together as a versioned Git collection.
The current profile requires BB 0.48.1, Plugin SDK 0.6.104 and Node 26 or newer.
The core package alone does not install either plugin. Existing task bindings
from an older plugin are not migrated; qualify each release with new tasks.

## Install and update

Use the `bb/` tag namespace and select one collection entry per install:

```sh
bb plugin install git:https://github.com/Velklish/promptobus.git@^0.2.0 --tag-prefix bb/ --plugin promptobus
bb plugin install git:https://github.com/Velklish/promptobus.git@^0.2.0 --tag-prefix bb/ --plugin native-panel
bb promptobus doctor
bb promptobus runtime describe
```

A range tracks compatible releases; an exact tag or commit remains pinned.
Check updates with `bb plugin outdated`, then apply them with
`bb plugin update promptobus` and `bb plugin update promptobus-native-panel`.
Run both diagnostic commands again. Matching manifests alone do not establish
executing server/Host identity or a working model workflow.

Configure the dashboard's host, canonical store and native registry in Settings.
Select a task and connect its actual BB owner thread. The server validates its
latest native identity against the canonical task owner. The first binding does
not replay existing messages. New questions, results and reviews can wake the
owner while the page is closed. Canonical mailbox reads remain the acknowledgement.

## Build the collection

Build the root package and install each plugin's exact development dependencies.
Then run from the repository root:

```sh
npm run bb:release -- --directory /absolute/new/release-directory
```

The output contains `.bb/plugins.json`, both plugin packages and `release.json`.
The adapter's frozen source identity remains embedded in its server and Host.
The Host carries its exact public core package for package-relative root admission;
command modules retain a collection-local core dependency. Bundles live in
`bundle/`, outside the `dist/` directory BB replaces during a Git installation.
No installation, tag or push is performed by the build command.

Commit the collection to the repository's release-artifact branch and create an
annotated `bb/vX.Y.Z` tag on that artifact commit. Preserve the source revision and
file hashes in `release.json`; do not move a published tag. Test managed install
and update against two prepared versions before publishing the final source and
artifact tags. See the [release procedure](releasing.md) for core release gates.

## Verification boundary

Run both complete plugin suites, type checks, skills checks, builds and the
panel's clean-bundle check. The adapter suite includes a relocated Host test that
removes its checkout and dependencies before root admission and verifies tamper
refusal. The core standalone suite checks metadata-free import with explicit Host
runtime options.

Live qualification records the installed source/build, BB/SDK, model, effort,
thread identities, canonical messages, Stop/resume, reload and recovery outcomes.
Test Codex owner/worker/reviewer/approver, Cursor worker/approver and an OpenCode
worker separately. Source fixtures do not replace those model workflows or UI
checks. Record unavailable observations as unknown and unexecuted checks as
notRun; retain original failures and command receipts.
