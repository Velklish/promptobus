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
- `harnessStateHome(harness)` — where the package keeps its session registry for one harness, or `null`
- Command formatting and worker preamble text

## Standalone host

`createStandaloneHost` (`src/standalone.ts`) walks up from `cwd` looking for `promptobus.json` (`HOST_CONFIG`). If the file is missing, the root is the resolved `cwd` and the config is empty.

It reads: `commandName`, `locale`, `version`, `tools`, `rules`, `mcp`, `skills`.

The interface for that file, `HostFile`, declares one field the standalone host does not read: `generate`. It belongs to a **spawned repository's** own `promptobus.json`, which `spawn` reads by path ([03-cli](03-cli.md) § Spawn) — a generator belongs to the repository being spawned into, and a host describes a workspace, so no host method answers it. It is declared here because this is the interface every other field of that file is named in, and a field named nowhere is the drift `HostToolBin.version` already cost this package once.

`legacyLayout()` is always `null`. `pluginDir()` is `null`. `memorySection()` is `null`. `resolveRepo` accepts a path on disk, not a remote namespace. `cloneOf` descends from the root to the first directory with `.git`; the root itself is never a clone. `reviewLayoutError` knows `not-clone`, `outside`, `no-clone`, `cwd-outside`, `ask-path`; a host that requires a shape of clone (a group/repo pair, a known zone) words that in its `no-clone` text.

`routingPaths()` answers `cacheFile` `~/.promptobus/model-routing/cache.json` and two overlays, `user` at `~/.promptobus/model-routing.json` and `workspace` at `<promptobusHome>/model-routing.json` — the writable one. Standalone declares no product-policy layer; a consumer inserts its own between those two, read-only.

`harnessStateHome(harness)` answers `~/.promptobus/<harness>` — the path the package used to guess — so a single-user checkout sets no variable and notices no change.

`syncHint()` returns `<commandName> install`.

## Model-routing paths

`routingPaths()` is the only source of routing paths. The cache and the `user` overlay are **account-scoped** — auth, model inventory and the remaining subscription limit belong to the account the harness binary is logged into, not to one workspace — so they do not hang off `promptobusHome()`, which stays the per-workspace task store. `overlays` is a list, ordered lowest precedence first, because a consumer's shipped policy is a layer between the person's two and a list lets the host place it without another change to the interface. `id` names a layer in diagnostics. A path the host names need not exist: a missing overlay is normal.

**One more file lives in that directory, and the host does not name it.** `promptobus done` appends a participant telemetry record to `telemetry.jsonl` beside `cacheFile` — same directory, same mode `0600`, same account scope ([03-cli](03-cli.md) § Participant telemetry). It is deliberately not a method: it is one leaf inside a directory the host already owns, and a second path to declare would let a consumer put the telemetry of one account beside the availability of another. **The consequence for a consumer is that moving the cache moves the telemetry with it** — the two are read together by the calibration pass, and a `cacheFile` that changes between releases leaves the old records behind rather than migrating them. The file is the ACCOUNT's, not one workspace's, for the reason the cache is: every checkout on the machine reaches the same logged-in account, and `promptobusHome()` — the per-workspace task store — is not used for it at all.

`routingPaths()` is a required member of `PromptobusHost`, not an optional one: an existing host implementation must add it, and `tsc` says so at the call site rather than at the first routed run. Consumers meet that once, at the release that closes the routing series.

## The writable layer

A layer carries `writable?: boolean`, and **exactly one layer carries it whenever any layer is declared**. `readLayers` refuses zero and refuses two, naming the layers it found; a host that declares no overlay at all declares nothing to write, which is lawful and is what a consumer with no overlays has.

The refusal is at the DECLARATION and not at the write, for the reason `harnessStateHome` refuses instead of guessing: a host that names layers and no writable one has an incomplete declaration, and a person who learns that from `models strategy --set` learns it after making the edit it refuses to keep. Two is the same fault from the other side — with two, which file the tool writes would depend on iteration order, and the loser's copy would sit on disk saying something nobody set.

**The writable layer is state, not configuration, so it must not be a file anybody commits.** That is what moved the standalone `workspace` layer out of the repository root: its content is written by the tool ([ADR-004](../adr/adr-004-subscription-balance.md), decision 6 — PB-32 adds `models strategy --set`, which will record there the strategy an agent proposed and a person agreed to), and a file the tool rewrites cannot live where a person's edits and a repository's `.gitignore` are the contract. It is now `<promptobusHome>/model-routing.json`, which is per-workspace exactly as the old path was — what changed is which per-workspace directory. `<workspaceRoot>/model-routing.local.json` is **no longer read, and there is no fallback**: two paths under one layer id would make the file a person edits depend on which of them exists. A consumer keeps the layer wherever its own state lives, under the same one condition.

The cache and the `user` overlay are untouched by this and stay account-scoped: `promptobusHome()` names the workspace layer and nothing else.

A host should mark the **highest-precedence** layer, or the tool would write a value a layer above it overrides; the writer PB-32 adds will warn when that happens rather than leave the person to wonder why their default did not take. `models validate` prints which layer is writable beside its path, and reports a declaration that is not exactly-one-writable as a finding — the command a person runs to check their stack must not say it holds while `models` refuses to run on it.

See [adr-003-model-routing.md](../adr/adr-003-model-routing.md) and [adr-004-subscription-balance.md](../adr/adr-004-subscription-balance.md).

## Harness state homes

`harnessStateHome(harness)` names where the package keeps its own session registry for that harness — the records `inspect`, `stop` and the wake path read and write. Account-scoped for the same reason the routing cache is: a session a harness keeps alive belongs to the account its binary is logged into, not to one workspace.

Precedence at the call site is `PROMPTOBUS_<HARNESS>_HOME` from the environment, then this method, then a refusal that names both. There is no default. The default is what went wrong: the package fell back to `~/.promptobus/<harness>` when the variable was unset, and a consumer that had named its own variables instead had two harness registries writing into the operator's real home while `inspect` read the sandbox — two halves of one test in different directories, with no error anywhere. A named refusal costs one message.

`harnessStateHome()` is a required member of `PromptobusHost`, the second the routing series adds: an existing host implementation must add it, and `tsc` says so. Consumers meet both once, at the release that closes the series.

The host is bound for the process by `runPromptobus` (and by `hostOf` for the package's own helper), because the registry helpers are called from places with no host in reach — `inspect(ref)` takes a ref and nothing else. Two hosts in one process share that binding and the **first** one wins — a host bound later cannot move the registries out from under a run already going. It is the one exception to "no process-wide singleton", and it is written at the top of `lib/cli.js`.

## Tool binaries

`resolveToolBin(name)` receives the name a driver DECLARES, and that is the name of the binary, not of the harness. For Cursor those differ: the harness is `cursor`, the binary is `cursor-agent`. It said `cursor` until 2026-09-05, and the standalone host — which hands a name back without searching — sent that through `PATH` into an operator's own `~/.local/bin/cursor`. A host that switches on the name meets `cursor-agent` at the release that closes the routing series; `--harness cursor` and the `tools` list are unchanged.

`HostToolBin` answers `ok`, `bin`, `version`, `note`, `warn` and `reason`. Only `bin` reaches a process spawn; the rest are read to talk to a person. **`version` is optional and its absence means UNREAD, never "old".** It holds the binary's own version string as the host read it — the raw `--version` line — and a host that does not probe versions returns none.

**The standalone host is one of those, deliberately.** It does not search for the binary, so the only way to learn a version would be to start it, and `resolveToolBin` is synchronous: that means `spawnSync` on the lift path and inside the availability preflight, where a blocking resolve stops the single budget timer that caps the whole probe. So under the standalone host the `ultracode` refusal never refuses, the two proven-version warnings (`PROVEN_CURSOR_VERSION`, `PROVEN_CODEX_VERSION`) never warn, and an availability verdict carries no version. The drivers' comments say "version unread — we do not refuse", and this is which host that is: the shipped one, by default, not a rare case. A consumer host that probes fills the field and gets all three back.

## Consumer identity inside a harness

`commandName` is not only what a printed command line says. For Codex it is the namespace the participant's own MCP tools live in: the `config.mcp_servers` override merges with the operator's personal config **by field**, so one name carrying two transports fails the whole config load, and the package moves its records into a namespace the personal file does not use. That namespace is `<commandName>-`, so a participant reads `mcp__<commandName>-promptobus__promptobus_send` and sees the CLI it is running under.

Two values have to be the same string: the config key the detached holder writes, and the tool name the prompt tells the participant to call. They are one function called twice — the driver builds both from `codexMcpPrefix(host)`. The prefix reaches the holder through the **session record**, not through a host: the holder is a separate process handed one record file, and there is no host in it to ask.

A third place names the same key: the wake text, which tells a participant to fetch its mailbox. It has no host either — a notification carries a task and an address and nothing else — so it takes the prefix off the same record. A record written before the prefix moved onto it carries none, and waking it refuses with the line the stale-holder branch beside it uses: lift the participant again. Nothing guesses a prefix, because a guessed key names a tool the session does not have.

That is why `DriverPhrases.tool(server, name, host)` takes a host. A driver whose spelling does not depend on the workspace ignores the argument — Claude Code and Cursor do. Two hosts with different `commandName` in one process produce two different namespaces, which is the property that makes a process-wide host unnecessary here as everywhere else.

## Passing the host

`lib/cli.js` refuses to run without `host.commandName`. `lib/store.js` refuses `promptobusHome`, `rootOfHome`, `ensureStore`, and related helpers without a host: a missing host is not the same as `legacyLayout() === null`.
