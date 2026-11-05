# PB-423 · Four suite files copy process.execPath and fail on a Node build linked against a shared libnode

- **Scope:** [Suite isolation](../../guides/contributing.md#suite-isolation)
- **Created:** 2026-11-05
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 410
- **Taken:** 2026-11-05

## Context

`shared-service-native-store`, `standalone-owner-recovery`, `stub-command-replacement` and `shared-service-standalone-root` copy `process.execPath` into their sandbox and start the copy as a native executable. The Homebrew build of Node links `@rpath/libnode.147.dylib`; the copy finds no library beside it and does not start, so `npm test` is red on that build regardless of the change under test.

Evidence: 2026-11-05 on `4acbb783`, macOS, Homebrew Node 26.13.0 (`otool -L $(which node)` lists `@rpath/libnode.147.dylib`). Each file standalone, twice: `stub-command-replacement` exit 13, `dyld: Library not loaded: @rpath/libnode.147.dylib`; `shared-service-standalone-root` exit 1, 18/27 before abort, the same `dyld` line; `shared-service-native-store` exit 1, "Owned native-store fixture did not reach its hook receipt"; `standalone-owner-recovery` exit 1, "Owned recovery fixture did not reach its exact phase". The copies are made at `test/stub-command-replacement.test.mjs:15`, `test/shared-service-standalone-root.test.mjs:19`, `test/shared-service-native-store.test.mjs:18` and `test/standalone-owner-recovery.test.mjs:16`. With the official Node 26.13.0 build first on `PATH` the four files pass: 7/7, 73/73, 7/7, 22/22, exit 0 each.

Next step: decide whether the suite supports Node builds with a shared libnode; if it does, the copy has to carry what the executable links, or the fixture has to refuse with a named reason instead of an unrelated timeout.

## Work to do

- Choose between supporting the build and refusing it by name.

## Out of scope

- Product behaviour on such a build.

## Verification

- The four files on a Homebrew Node build: green, or a refusal that names the shared library.
