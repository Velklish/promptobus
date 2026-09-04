# Host

The bus does not search for a workspace. The caller passes `PromptobusHost` (`src/host.ts`) into every function that needs one. See [adr-002-standalone-host-contract.md](../adr/adr-002-standalone-host-contract.md).

## Marker

`kind` is the string `promptobus-host` (`HOST_KIND`). `isPromptobusHost` checks `kind`, `workspaceRoot`, and `commandName`.

## What the host must answer

- Identity: `id`, `commandName`, `version`, `locale`
- Roots: `workspaceRoot()`, `promptobusHome()`, `findRoot(cwd)`
- Binaries: `nodePath()`, `binPath()`, `layoutBinPath()`
- Layout relatives: tools manifest, skills, plugin, bus hook, install manifest, repos root
- `declaredTools()` — harness names allowed for `--harness`
- Rules and module notes for a repo directory
- `participantServers()` — MCP map copied to a spawned session (the bus server is added by the CLI)
- `resolveRepo`, freshness, extra env, tool binaries
- `legacyLayout()` — former store, or `null`
- Command formatting and worker preamble text

## Standalone host

`createStandaloneHost` (`src/standalone.ts`) walks up from `cwd` looking for `promptobus.json` (`HOST_CONFIG`). If the file is missing, the root is the resolved `cwd` and the config is empty.

It reads: `commandName`, `locale`, `version`, `tools`, `rules`, `mcp`, `skills`.

`legacyLayout()` is always `null`. `pluginDir()` is `null`. `memorySection()` is `null`. `resolveRepo` accepts a path on disk, not a remote namespace. `reviewLayoutError` returns `null` for pair-layout kinds this host does not use.

`syncHint()` returns `<commandName> install`.

## Passing the host

`lib/cli.js` refuses to run without `host.commandName`. `lib/store.js` refuses `promptobusHome`, `rootOfHome`, `ensureStore`, and related helpers without a host: a missing host is not the same as `legacyLayout() === null`.
