# Host

The bus does not search for a workspace. The caller passes `PromptobusHost` (`src/host.ts`) into every function that needs one. See [adr-002-standalone-host-contract.md](../adr/adr-002-standalone-host-contract.md).

## Marker

`kind` is the string `promptobus-host` (`HOST_KIND`). `isPromptobusHost` checks `kind`, `workspaceRoot`, and `commandName`.

## What the host must answer

- Identity: `id`, `commandName`, `version`, `locale`
- Roots: `workspaceRoot()`, `promptobusHome()`, `findRoot(cwd)`
- Binaries: `nodePath()`, `binPath()`, `layoutBinPath()`
- Layout relatives: tools manifest, skills, plugin, bus hook, install manifest
- `cloneOf(abs)` — the clone a directory belongs to and its namespace path, or `null`; zones and namespace depth are the host's layout, the package never walks the tree
- `declaredTools()` — harness names allowed for `--harness`
- Rules and module notes for a repo directory
- `participantServers()` — MCP map copied to a spawned session (the bus server is added by the CLI)
- `resolveRepo`, freshness, extra env, tool binaries
- `legacyLayout()` — former store, or `null`
- `routingPaths()` — model-routing files: the availability cache and the overlay layers, lowest precedence first
- Command formatting and worker preamble text

## Standalone host

`createStandaloneHost` (`src/standalone.ts`) walks up from `cwd` looking for `promptobus.json` (`HOST_CONFIG`). If the file is missing, the root is the resolved `cwd` and the config is empty.

It reads: `commandName`, `locale`, `version`, `tools`, `rules`, `mcp`, `skills`.

`legacyLayout()` is always `null`. `pluginDir()` is `null`. `memorySection()` is `null`. `resolveRepo` accepts a path on disk, not a remote namespace. `cloneOf` descends from the root to the first directory with `.git`; the root itself is never a clone. `reviewLayoutError` knows `not-clone`, `outside`, `no-clone`, `cwd-outside`, `ask-path`; a host that requires a shape of clone (a group/repo pair, a known zone) words that in its `no-clone` text.

`routingPaths()` answers `cacheFile` `~/.promptobus/model-routing/cache.json` and two overlays, `user` at `~/.promptobus/model-routing.json` and `workspace` at `<workspaceRoot>/model-routing.local.json`. Standalone declares no product-policy layer; a consumer inserts its own between those two.

`syncHint()` returns `<commandName> install`.

## Model-routing paths

`routingPaths()` is the only source of routing paths. The cache and the `user` overlay are **account-scoped** — auth, model inventory and the remaining subscription limit belong to the account the harness binary is logged into, not to one workspace — so they do not hang off `promptobusHome()`, which stays the per-workspace task store. `overlays` is a list, ordered lowest precedence first, because a consumer's shipped policy is a layer between the person's two and a list lets the host place it without another change to the interface. `id` names a layer in diagnostics. A path the host names need not exist: a missing overlay is normal.

`routingPaths()` is a required member of `PromptobusHost`, not an optional one: an existing host implementation must add it, and `tsc` says so at the call site rather than at the first routed run. Consumers meet that once, at the release that closes the routing series.

See [adr-003-model-routing.md](../adr/adr-003-model-routing.md).

## Passing the host

`lib/cli.js` refuses to run without `host.commandName`. `lib/store.js` refuses `promptobusHome`, `rootOfHome`, `ensureStore`, and related helpers without a host: a missing host is not the same as `legacyLayout() === null`.
