# Host

The bus does not search for a workspace. The caller passes `PromptobusHost` (`src/host.ts`) into every function that needs one. See [adr-002-standalone-host-contract.md](../adr/adr-002-standalone-host-contract.md).

## Marker

`kind` is the string `promptobus-host` (`HOST_KIND`). `isPromptobusHost` checks `kind`, `workspaceRoot`, and `commandName`.

## What the host must answer

The table below is pinned to the current `PromptobusHost` declaration in `src/host.ts`: five readonly identity fields and 46 methods. The last column records the meaning of a nullable or absent result; an empty array, empty string, `false`, or an object with optional fields absent has the ordinary meaning stated there.

| Member | Signature | Meaning of `null` or an absent answer |
|---|---|---|
| `kind` | `readonly kind: typeof HOST_KIND` | Never absent; it is the host marker checked by `isPromptobusHost`. |
| `id` | `readonly id: string` | Never absent; it identifies this host instance. |
| `commandName` | `readonly commandName: string` | Never absent; it is the command word used in diagnostics and consumer tool names. |
| `version` | `readonly version: string` | Never absent; it is the reader version selected for this host's store. |
| `locale` | `readonly locale: string` | Never absent; it selects the host's presentation locale. |
| `workspaceRoot` | `workspaceRoot(): string` | Never absent; it is the workspace root. |
| `promptobusHome` | `promptobusHome(): string` | Never absent; it is the authoritative task-store home. |
| `findRoot` | `findRoot(cwd: string): string \| null` | `null` means no host root was found for the path; standalone falls back to the resolved `cwd`. |
| `routingPaths` | `routingPaths(): HostRoutingPaths` | Never absent; the returned cache path and overlay list are the routing declaration. |
| `harnessStateHome` | `harnessStateHome(harness: string): string \| null` | `null` means the host names no registry for that harness, so a session operation refuses instead of guessing. |
| `nodePath` | `nodePath(): string` | Never absent; it is the Node executable used for launches. |
| `binPath` | `binPath(): string` | Never absent; it is the host's CLI entry used by participant launches. |
| `layoutBinPath` | `layoutBinPath(): string` | Never absent; it is the entry path written into project hooks. |
| `toolsManifestRel` | `toolsManifestRel(): string` | Never absent; it is the workspace-relative harness declaration path. |
| `skillsDir` | `skillsDir(): string \| null` | `null` means the workspace has no configured process-skills directory. |
| `pluginDir` | `pluginDir(): string \| null` | `null` means no plugin directory is available for the workspace. |
| `pluginManifestRel` | `pluginManifestRel(): string` | Never absent; it is the workspace-relative plugin manifest path. |
| `busHookRel` | `busHookRel(): string` | Never absent. Nothing is written there any more; it is the path by which `install` recognises and removes a feed hook an earlier version left. |
| `installManifestRel` | `installManifestRel(): string` | Never absent; it is the workspace-relative install manifest path. |
| `pluginSkillsRel` | `pluginSkillsRel(): string` | Never absent; it is the workspace-relative plugin-skills path. |
| `declaredTools` | `declaredTools(): string[]` | Never `null`; an empty array means the workspace declares no harnesses. |
| `collectRules` | `collectRules(repoDir: string): string[]` | Never `null`; an empty array means no rule files were found for the repository. |
| `moduleNote` | `moduleNote(repoDir: string): HostModuleNote` | Never absent; the note is `info` or `warn` even when the repository has no module-specific guidance. |
| `resolveRepoModule` | `resolveRepoModule(repoDir: string): HostRepoModule \| null` | `null` means no repository module metadata applies. |
| `reviewSkillDir` | `reviewSkillDir(name: string): string` | Never absent; the path may not exist, which the reviewer reports separately. |
| `participantServers` | `participantServers(): HostServers` | Never absent; empty `servers` and `external` mean no extra participant MCP servers. |
| `participantDenyTools` | `participantDenyTools?(role: string): HostMcpToolClassification` | Optional member; `{ tools, complete: true }` is a complete classification (including an empty `tools` array), while `complete: false` is an incomplete answer for a mechanical reviewer. |
| `memorySection` | `memorySection(toolName: (server: string, name: string) => string): string \| null` | `null` means this host has no memory integration section. |
| `resolveRepo` | `resolveRepo(query: string): Promise<HostRepo>` | It rejects with `HostResolveError` when unresolved; it does not return `null`. |
| `repoAbsPath` | `repoAbsPath(nsPath: string): string` | Never absent; the host returns the absolute path for the namespace. |
| `isClone` | `isClone(abs: string): boolean` | Never `null`; `false` means the path is not a clone. |
| `formatCandidate` | `formatCandidate(candidate: HostRepoCandidate): string` | Never absent; it supplies the human-readable candidate text. |
| `inWorkspace` | `inWorkspace(abs: string): boolean` | Never `null`; `false` means the path is outside the host workspace. |
| `cloneOf` | `cloneOf(abs: string): HostClone \| null` | `null` means no clone in this workspace contains the path. |
| `reviewLayoutError` | `reviewLayoutError(kind: 'not-clone' \| 'outside' \| 'no-clone' \| 'cwd-outside' \| 'ask-path', ctx?: { targetDir?: string; repoDir?: string; abs?: string; dir?: string }): string \| null` | `null` means this host has no extra refusal text for that layout case. |
| `defaultBranch` | `defaultBranch(repoDir: string): string \| null` | `null` means Git could not identify a default branch. |
| `freshenRepo` | `freshenRepo(repoDir: string): HostFreshness` | The result is required; its nullable freshness fields mean Git could not measure those fields. |
| `reportFresh` | `reportFresh(result: HostFreshness, label: string): void` | No answer is expected; the host reports or deliberately ignores freshness. |
| `extraEnv` | `extraEnv(): Record<string, string>` | Never `null`; an empty object means no host environment overrides. |
| `resolveToolBin` | `resolveToolBin(name: string): HostToolBin` | The result is required; `bin` may be absent when no launch path is available, and `version` absent means unread, not old. |
| `substituteVars` | `substituteVars(value: unknown): unknown` | `null` may be a legitimate transformed value, not an absent host answer. |
| `legacyLayout` | `legacyLayout(): HostLegacyLayout \| null` | `null` means this workspace has no former store and migration does not run. |
| `formatCommand` | `formatCommand(args: string[]): string` | Never absent; it formats a command for a person. |
| `formatNpx` | `formatNpx(args: string[]): string` | Never absent; it formats a consumer-owned command for a person, never a bus subcommand. |
| `busCommand` | `busCommand(args: string[]): string` | Never absent; it formats a bus command for diagnostics. |
| `busArgv` | `busArgv(args: string[]): string[]` | Never `null`; it returns the complete launch argv without a leading `node`. |
| `guardArgv` | `guardArgv(args: string[]): string[]` | Never `null`; it returns the complete hook launch argv without a leading `node`. |
| `cloneHint` | `cloneHint(nsPath: string): string` | Never absent; it gives the person a clone command or equivalent guidance. |
| `syncHint` | `syncHint(): string` | Never absent; it gives the command that refreshes project integration. |
| `workerPreamble` | `workerPreamble(ctx: { taskId: string; nsPath: string; branch: string }): string` | Never absent; it supplies the worker's host-specific preamble. |
| `liveRunNote` | `liveRunNote(nsPath: string): string` | Never absent; an empty string means this host has no extra live-run note. |

`promptobusHome()` is the authoritative task-store path. Store commands use that answer directly; they do not rebuild `<workspaceRoot>/.promptobus`, because a host may deliberately choose another home. A host whose `legacyLayout()` is not `null` MUST run `preflight()` and, when its plan says so, `migrate()` inside its own `promptobusHome()`; both functions are package-root exports, and a preflight refusal must surface from that member. The `status`, `history`, `dismiss`, and `prune` commands no longer perform migration on the host's behalf. The standalone host returns its configured `home` directly and declares `legacyLayout() === null`, so there is no migration to skip.

`formatNpx()` exists for commands owned by the consumer CLI. It must never wrap a bus subcommand: package-owned hints use `busCommand()`, whose host-defined spelling places the command under the bus entry point. The two formatters may happen to return similar text on the standalone host, but they are separate contract members because a consumer host can place its own commands and the bus at different command paths.

## `legacyLayout()`

`legacyLayout()` declares the former store as a two-segment relative path and supplies the former CLI's close command. `null` means that this host has no former store and migration never runs.

Migration writes `migrating.json` into the assembled new store before the atomic switch. The mark authorizes only cleanup interrupted between that switch and removal of the former directory; after the former directory is removed successfully, the mark is removed too. If the former directory is already gone but that final removal was interrupted, `preflight()` reports `needed: true, sweep: true` and the next open removes the dead mark; it authorizes nothing and does not report a data move. Accordingly, `migrationNeeded()` remains true because cleanup is still needed; callers that need to distinguish a data move use `preflight().sweep`. A former store that appears beside the new store later is refused rather than resumed. In particular, `migrated.json` left by an older release is a completed-migration record, not cleanup authorization: a matching path alone never permits deletion.

Migration also refuses before mutation if the former `tasks/` contains a non-empty directory entry whose name is outside the v1 task-id grammar: 1 to 128 characters, with an ASCII letter or digit first and then ASCII letters, digits, `.`, `_`, or `-`. The check runs before resumed-cleanup detection because cleanup removes the former root whole: an entry migration cannot move must not disappear with it. An empty invalid directory carries no data and is skipped. The bus will not open until an operator renames or removes a refused entry by hand and repeats the command.

## Standalone host

`createStandaloneHost` (`src/standalone.ts`) walks up from `cwd` looking for `promptobus.json` (`HOST_CONFIG`). If the file is missing, the root is the resolved `cwd` and the config is empty.

It reads: `commandName`, `locale`, `version`, `tools`, `rules`, `mcp`, `skills`.

The shipped `bin/promptobus.js` always supplies `commandName: 'promptobus'` and the
package version to `createStandaloneHost`. Therefore `commandName` and `version` in
`promptobus.json` never affect the shipped bin; it does not honor those two fields.

The interface for that file, `HostFile`, declares one field the standalone host does not read: `generate`. It belongs to a **spawned repository's** own `promptobus.json`, which `spawn` reads by path ([03-cli](03-cli.md) § Spawn) — a generator belongs to the repository being spawned into, and a host describes a workspace, so no host method answers it. It is declared here because this is the interface every other field of that file is named in, and a field named nowhere is the drift `HostToolBin.version` already cost this package once.

`legacyLayout()` is always `null`. `pluginDir()` is `null`, so its absence is not a plugin warning; the participant instead says that this host ships no workspace-skills plugin. `memorySection()` is `null`. `resolveRepo` accepts a path on disk, not a remote namespace. `cloneOf` descends from the root to the first directory with `.git`; the root itself is never a clone. `reviewLayoutError` knows `not-clone`, `outside`, `no-clone`, `cwd-outside`, `ask-path`; a host that requires a shape of clone (a group/repo pair, a known zone) words that in its `no-clone` text.

`routingPaths()` answers `cacheFile` `~/.promptobus/model-routing/cache.json` and two overlays, `user` at `~/.promptobus/model-routing.json` and `workspace` at `<promptobusHome>/model-routing.json` — the writable one. Standalone declares no product-policy layer; a consumer inserts its own between those two, read-only.

`harnessStateHome(harness)` answers `~/.promptobus/<harness>` — the path the package used to guess — so a single-user checkout sets no variable and notices no change.

`syncHint()` returns `<commandName> install`.

`guardArgv(args)` is a required member of `PromptobusHost`, next to
`layoutBinPath()`. It returns the complete argv for the loop guard, without a
leading `node`; `args` starts with `guard`. A host whose command lives below a
prefix includes that prefix in the answer, for example
`[layoutBinPath(), 'promptobus', 'guard', …]`. `guardHookCommand` quotes this
host-provided argv and does not infer a command word. Existing host
implementations must provide this member before calling `install`, `spawn`, or
`review`; otherwise guard hook assembly throws `TypeError`.

For the standalone host, the default `promptobus` entry retains the established
optional prefix for byte-compatible installs.

`participantDenyTools(role)` is an optional member. For `reviewer`, it returns
`{ tools, complete }`, where `tools` contains the exact `{ server, tool }` pairs
that the host knows are write tools of its canonical external MCP servers; it must
not infer them from names and must not return the Promptobus bus. `complete: true`
means the host has finished classifying its canonical external servers, even when
there are no write tools. A mechanical reviewer refuses before launch when the
answer is incomplete, or when a host that hands the participant any server but the
bus has no member — the classification must cover every server the host hands the
participant, not only the third-party ones; the refusal names the host and servers
left unclassified. A host with a
complete answer lets the driver translate the pairs into its own deny syntax. The
standalone host returns `{ tools: [], complete: true }` because its `mcp` map is
opaque and has no external write policy.

This is a breaking shape migration: a legacy array answer is incomplete, so the host
must ship `{ tools, complete }` in the same pin.

This member and the optional `mcpDenyTools` capability flag are contract extensions,
so a host and package release must advance together. When a participant journal from
the newer release contains that capability and an older reader sees the unknown key,
the mechanism marker makes the diagnosis `schema-version-unsupported`: start a new
session rather than repairing a valid journal.

## Model-routing paths

`routingPaths()` is the only source of routing paths. The cache and the `user` overlay are **account-scoped** — auth, model inventory and the remaining subscription limit belong to the account the harness binary is logged into, not to one workspace — so they do not hang off `promptobusHome()`, which stays the per-workspace task store. `overlays` is a list, ordered lowest precedence first, because a consumer's shipped policy is a layer between the person's two and a list lets the host place it without another change to the interface. `id` names a layer in diagnostics. A path the host names need not exist: a missing overlay is normal.

**One more file lives in that directory, and the host does not name it.** `promptobus done` appends a participant telemetry record to `telemetry.jsonl` beside `cacheFile` — same directory, same mode `0600`, same account scope ([03-cli](03-cli.md) § Participant telemetry). It is deliberately not a method: it is one leaf inside a directory the host already owns, and a second path to declare would let a consumer put the telemetry of one account beside the availability of another. **The consequence for a consumer is that moving the cache moves the telemetry with it** — the two are read together by the calibration pass, and a `cacheFile` that changes between releases leaves the old records behind rather than migrating them. The file is the ACCOUNT's, not one workspace's, for the reason the cache is: every checkout on the machine reaches the same logged-in account, and `promptobusHome()` — the per-workspace task store — is not used for it at all.

`routingPaths()` is a required member of `PromptobusHost`, not an optional one: an existing host implementation must add it, and `tsc` says so at the call site rather than at the first routed run. Consumers meet that once, at the release that closes the routing series.

## The writable layer

A layer carries `writable?: boolean`, and **exactly one layer carries it whenever any layer is declared**. `readLayers` refuses zero and refuses two, naming the layers it found; a host that declares no overlay at all declares nothing to write, which is lawful and is what a consumer with no overlays has.

The refusal is at the DECLARATION and not at the write, for the reason `harnessStateHome` refuses instead of guessing: a host that names layers and no writable one has an incomplete declaration, and a person who learns that from `models strategy --set` learns it after making the edit it refuses to keep. Two is the same fault from the other side — with two, which file the tool writes would depend on iteration order, and the loser's copy would sit on disk saying something nobody set.

**The writable layer is state, not configuration, so it must not be a file anybody commits.** That is what moved the standalone `workspace` layer out of the repository root: its content is written by the tool ([ADR-004](../adr/adr-004-subscription-balance.md), decision 6 — PB-32 adds `models strategy --set`, which will record there the strategy an agent proposed and a person agreed to), and a file the tool rewrites cannot live where a person's edits and a repository's `.gitignore` are the contract. It is now `<promptobusHome>/model-routing.json`, which is per-workspace exactly as the old path was — what changed is which per-workspace directory. `<workspaceRoot>/model-routing.local.json` is **no longer read, and there is no fallback**: two paths under one layer id would make the file a person edits depend on which of them exists. A consumer keeps the layer wherever its own state lives, under the same one condition.

The cache and the `user` overlay are untouched by this and stay account-scoped: `promptobusHome()` names the workspace layer and nothing else.

**One command writes a layer that is not the writable one, and it is named here so the rule above stays readable.** `promptobus models calibrate --write` merges calibrated `ratings` into the layer whose id is `user` ([ADR-005](../adr/adr-005-ten-point-scale-absolute-bands-calibrate.md), superseding one sentence of ADR-004's host contract for this command alone). It is deliberately not the writable layer: a rating is a property of the account, which runs the same models in every workspace, while the writable layer is per-workspace state. The exception is that narrow — only that command, only the `ratings` block, and only after its text proposal has been printed and the person has agreed to those exact lines — and it changes nothing about "exactly one writable layer", which still governs everything the tool writes on its own. If a higher layer already names a tuple/rating pair being written, a successful write warns with that layer and pair because the `user` value is shadowed; the JSON outcome reports the same pairs in `write.shadowedBy`. Without a terminal, `--write` without `--yes` refuses even when no rating would move; in text mode that refusal follows the proposal, while `--json` raises it before its document. A host that declares no `user` layer refuses that write, naming the layers it does declare.

A host should mark the **highest-precedence** layer, or the tool would write a value a layer above it overrides; the writer PB-32 adds will warn when that happens rather than leave the person to wonder why their default did not take. `models validate` prints which layer is writable beside its path, and reports a declaration that is not exactly-one-writable as a finding — the command a person runs to check their stack must not say it holds while `models` refuses to run on it.

See [adr-003-model-routing.md](../adr/adr-003-model-routing.md) and [adr-004-subscription-balance.md](../adr/adr-004-subscription-balance.md).

## Harness state homes

`harnessStateHome(harness)` names where the package keeps its own session registry for that harness — the records `inspect`, `stop` and the wake path read and write. Account-scoped for the same reason the routing cache is: a session a harness keeps alive belongs to the account its binary is logged into, not to one workspace.

Precedence at the call site is `PROMPTOBUS_<HARNESS>_HOME` from the environment, then this method, then a refusal that names both. There is no default. The default is what went wrong: the package fell back to `~/.promptobus/<harness>` when the variable was unset, and a consumer that had named its own variables instead had two harness registries writing into the operator's real home while `inspect` read the sandbox — two halves of one test in different directories, with no error anywhere. A named refusal costs one message. The Codex driver's operator-facing `participant threads` phrase resolves this same home when it prints the registry path; if neither source answers, it names the source rather than guessing a default.

Registry reads propagate that `GateError` rather than answer empty, as do direct driver calls to `inspect`, `stop` and `activate`; `gone`, `null`, `[]` and “no session record in the registry” are reserved for a home that was resolved and then contained no matching readable record. The aggregate `snapshotSessions` path deliberately degrades every driver error to `unknown` so one participant cannot take down `status`, `done` or the supervisor; a `GateError` refusal is carried into that unknown as its reason, so `status` names the variable and `harnessStateHome` instead of dropping the refusal, while other driver errors remain reasonless. The wake-side `registerWake` and `sessionPrefix` paths retain their deliberate safety catches too. Those three exceptions are the current boundary, not an empty-registry answer.

`harnessStateHome()` is a required member of `PromptobusHost`, the second the routing series adds: an existing host implementation must add it, and `tsc` says so. Consumers meet both once, at the release that closes the series.

The host is bound for the process by `runPromptobus` (and by `hostOf` for the package's own helper), because the registry helpers are called from places with no host in reach — `inspect(ref)` takes a ref and nothing else. Two hosts in one process share that binding and the **first** one wins — a host bound later cannot move the registries out from under a run already going. It is the one exception to "no process-wide singleton", and it is written at the top of `lib/cli.js`.

## Tool binaries

`resolveToolBin(name)` receives the name a driver DECLARES, and that is the name of the binary, not of the harness. For Cursor those differ: the harness is `cursor`, the binary is `cursor-agent`. It said `cursor` until 2026-09-05, and the standalone host — which hands a name back without searching — sent that through `PATH` into an operator's own `~/.local/bin/cursor`. A host that switches on the name meets `cursor-agent` at the release that closes the routing series; `--harness cursor` and the `tools` list are unchanged.

When a driver supplies an environment to `run`, that same environment governs command resolution as well as the child process. On Windows, `planRun` reads its `PATH`, `PATHEXT` and `ComSpec`, and the execution trace reads the same `PATH` and `PATHEXT`; `process.env` is only the fallback when the caller supplies no `env`. A host may therefore return a bare binary name without defeating a caller's sealed or deliberately reduced `PATH`.

Cursor's stop path re-resolves its binary with the preference `cursor-agent`, then `agent`, then `cursor`, searching `PATH` and the known install directories (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`). The environment passed to `stop` controls both that resolution and the `persist stop` command, so teardown does not silently resolve against `process.env` while executing with another environment.

`HostToolBin` answers `ok`, `bin`, `version`, `note`, `warn` and `reason`. Only `bin` reaches a process spawn; the rest are read to talk to a person. **`version` is optional and its absence means UNREAD, never "old".** It holds the binary's own version string as the host read it — the raw `--version` line — and a host that does not probe versions returns none.

**The standalone host is one of those, deliberately.** It does not search for the binary, so the only way to learn a version would be to start it, and `resolveToolBin` is synchronous: that means `spawnSync` on the lift path and inside the availability preflight, where a blocking resolve stops the single budget timer that caps the whole probe. So under the standalone host the `ultracode` refusal never refuses, the two proven-version warnings (`PROVEN_CURSOR_VERSION`, `PROVEN_CODEX_VERSION`) never warn, and an availability verdict carries no version. The drivers' comments say "version unread — we do not refuse", and this is which host that is: the shipped one, by default, not a rare case. A consumer host that probes fills the field and gets all three back.

## Consumer identity inside a harness

`commandName` is not only what a printed command line says. For Codex it is the namespace the participant's own MCP tools live in: the `config.mcp_servers` override merges with the operator's personal config **by field**, so one name carrying two transports fails the whole config load, and the package moves its records into a namespace the personal file does not use. That namespace is `<commandName>-`. The tool name the participant is told is the key **as Codex exposes it**: Codex sanitizes the key, every character outside `[A-Za-z0-9_]` becomes `_`, so under a CLI named `acme-tools` the config key is `acme-tools-promptobus` and the participant reads `mcp__acme_tools_promptobus__promptobus_send` (PB-160, measured on codex-cli 0.146.0). Told the raw key, a participant calls `tools.mcp__acme-tools-promptobus__promptobus_send(...)` inside Codex's `exec` harness — a subtraction, not a property — and the call fails in 0 ms with no text before any server is reached.

Two values have to agree: the config key the detached holder writes, and the tool name the prompt tells the participant to call — the second is the first passed through Codex's sanitization. They are one function called twice — the driver builds both from `codexMcpPrefix(host)`, and `codexToolSegment` is the only place the sanitization lives. The prefix reaches the holder through the **session record**, not through a host: the holder is a separate process handed one record file, and there is no host in it to ask.

A third place names the same key: the wake text, which tells a participant to fetch its mailbox. It has no host either — a notification carries a task and an address and nothing else — so it takes the prefix off the same record. A record written before the prefix moved onto it carries none, and waking it refuses with the line the stale-holder branch beside it uses: lift the participant again. Nothing guesses a prefix, because a guessed key names a tool the session does not have.

That is why `DriverPhrases.tool(server, name, host)` takes a host. A driver whose spelling does not depend on the workspace ignores the argument — Claude Code and Cursor do. Two hosts with different `commandName` in one process produce two different namespaces, which is the property that makes a process-wide host unnecessary here as everywhere else.

The spawn path chooses a readable participant session name from the work-slice title (`Worker: <title> (<MMDD-HHMM>)`; a reviewer uses `Review:`), stores it as `sessionRef`, and passes it through a driver-owned name seam when the harness accepts one. Codex applies that value with `thread/name/set`; its thread id remains harness-owned and is the lookup handle. A Codex record written before the name field existed falls back to `promptobus:<task>:<address>`, keeping older sessions addressable while new lifts remain readable. Cursor still lets the harness invent its persist session name.

## Session identity

**Who a session is comes from its driver, not from one harness's variable.** `DriverOptions.identityVar` names the environment variable a harness uses to name its own session, or `null` when it has none: `CLAUDE_CODE_SESSION_ID`, `CURSOR_CONVERSATION_ID`, `CODEX_THREAD_ID`. Task ownership, `claim`, the warden's claim and the loop guard all read the answer — 23 call sites across 8 modules — and until [ADR-010](../adr/adr-010-session-identity-is-a-driver-member.md) every one of them read the first of those three directly.

**The member answers for ONE path, and the distinction is measured rather than cautionary.** It answers for a command the session runs. It does NOT answer for the session's own MCP server: codex-cli 0.146.0 hands an MCP server child eleven variables — `HOME LOGNAME PATH PWD SHELL SHLVL TERM TMPDIR USER _ __CF_USER_TEXT_ENCODING` — with nothing harness-specific among them, so on that path identity from the environment is impossible, not merely unsupported. On the other path the old reader was worse than empty: a live Codex participant's environment carries its orchestrator's `CLAUDE_CODE_SESSION_ID`, and the reader returned **the parent's id** as the participant's own.

**Two claimants are refused, never picked.** `resolveSessionIdentity` gives the id when exactly one declared variable is set; `null` with a reason when none is; and `null` with a reason naming both claimants and their variables when two are — that pair is the leaked shape above, and choosing between them would hand out someone else's id. The contested case is warned once per process so the leak is readable; an environment that names no harness is a legal state and is not warned about, its reason staying on the resolver's `why`.

**The resolver is injected, not imported, and the registry injects itself.** `lib/drivers.js` binds it with `bindSessionIdentity` at import — the shape a driver already uses to bind participant-home removal into the session store — so whoever loads the registry can answer. `lib/cli.js` binds it explicitly too, beside `bindHarnessHomes`: its command modules are imported dynamically and not all of them load the registry. Every driver imports `lib/store.js`, so the back edge is a real cycle — with a direct import the package loads when `store.js` is the entry module and dies with `ReferenceError: Cannot access 'CLAUDE' before initialization` when a driver module is. Unbound, the core answers `null` and says once that no registry is bound; it never falls back to reading a variable itself.

## Passing the host

`lib/cli.js` refuses to run without `host.commandName`. `lib/store.js` refuses `promptobusHome`, `rootOfHome`, `ensureStore`, and related helpers without a host: a missing host is not the same as `legacyLayout() === null`.

## The harness session registry, and the refusal when nobody says

Source: `lib/harness-home.js`, `harnessStateHome`.

Where the package keeps its own session registry for one harness, and the refusal
when nobody says.

The registry holds the records `inspect`, `stop` and the wake path read and write.
It used to be `PROMPTOBUS_<HARNESS>_HOME` or, failing that, `~/.promptobus/<harness>`
— and that fallback was the bug. A consumer that had named its own variables instead
left the package seeing neither, so the Cursor and Codex registries wrote into the
operator's REAL home while `inspect` read the sandbox: two halves of one test looking
at different directories, with no error anywhere and nothing in either log to say so.
Found because a test behaved oddly, not by a gate (PB-2).

So the answer now comes from one of two places that were ASKED, and otherwise it is a
refusal that names both of them:

  1. `PROMPTOBUS_<HARNESS>_HOME` in the environment — how the suite and a person
     point the package at a sandbox, and it wins, because it is the most local thing
     anyone said;
  2. `host.harnessStateHome(<harness>)` — the workspace's answer. The standalone host
     answers `~/.promptobus/<harness>`, the old fallback, so a single-user checkout
     needs no variable and notices nothing;
  3. neither — `GateError`, naming the variable and the method.

That refusal is not an empty registry result: registry readers and direct driver
`inspect`, `stop` and `activate` calls rethrow it. The aggregate `snapshotSessions`
path deliberately degrades driver errors to `unknown`; wake-side `registerWake` and
`sessionPrefix` deliberately keep their safety catches. Only a registry directory
that was actually resolved and read can produce `null`, `[]`, or a “no session
record” stall.

**The host is bound once per process rather than threaded.** The registry helpers are
called from `inspect`, `stop`, holder start and the wake path — thirty-odd call sites,
most of them with no host in reach (`cursorDriver.inspect(ref)` takes a ref and
nothing else). Threading a host through all of them to reach two functions would be a
larger change than the one it protects, and a half-threaded version — a host on the
write path, none on the read path — would rebuild the very split this fixes. The
binding is set by whoever builds the host: `hostOf` in [host.js](../../lib/host.js) does it for
the package's own helper, and `runPromptobus` in [cli.js](../../lib/cli.js) does it for a
consumer that passes its own. Two hosts in one process share this one binding and the
FIRST one wins — the cost of not threading, written down where it is paid.

### The host contract, in one sentence per member

Source: `src/host.ts`.

Host contract: knowledge of the workspace the consumer passes into the bus
explicitly on every call. There is no process-wide singleton: two hosts in
one process are lawful and independent.

Field names are about a workspace in general, not about one consumer's
layout. Concrete paths (rules directory, tools manifest) are named by the
implementation.

### The standalone host

Source: `src/standalone.ts`.

Standalone host: a workspace from cwd, Git, and promptobus.json. There is no
foreign-mechanism layout, no remote namespaces, and no memory servers here —
that is a consumer implementation's business.

### The layer the tool writes

Source: `src/host.ts`.

Whether this is the layer the TOOL writes (ADR-004, decision 6). PB-32 adds
the writer, `models strategy --set`; until then the flag is a declaration
with no caller, which is the order this package takes everywhere — the
contract first, then what runs on it.

Exactly one layer carries it whenever any layer is declared; `readLayers`
refuses zero and refuses two, naming the layers it found. The refusal is at
the declaration rather than at the write for the reason `harnessStateHome`
refuses instead of guessing: a host that names layers and no writable one has
an incomplete declaration, and finding that out at the write costs a person
the edit they just made.

A writable layer is STATE, not configuration, so it must not be a file
anybody commits. Under the standalone host it is `workspace`, and it lives at
`<promptobusHome>/model-routing.json` for exactly that reason — a consumer
keeps it wherever its own state lives, under the same one condition.

A host should mark the HIGHEST-precedence layer, or the tool would write a
value a layer above it overrides; the writer PB-32 adds will warn when that
happens rather than leave the person to wonder why their default did not
take.

### `harnessStateHome` — the harness session registry, and the refusal when nobody says

Source: `src/host.ts`, `harnessStateHome`.

Where the package keeps its own session registry for one harness — the
records `inspect`, `stop` and the wake path read and write. Account-scoped
like `routingPaths()`, and for the same reason: a session a harness keeps
alive belongs to the account its binary is logged into, not to one
workspace. `null` means the host names none, and then a run refuses.

It refuses instead of guessing because the guess was measured. The package
used to fall back to `~/.promptobus/<harness>` when the per-harness
environment variable was unset. A consumer that had named its own
variables instead therefore had two harness registries writing into the
operator's REAL home while `inspect` read the sandbox — two halves of one
test looking at different directories, with no error anywhere and nothing
in either log to say so (PB-2). A named refusal costs one message; a
silent guess cost a day.

Precedence at the call site: `PROMPTOBUS_<HARNESS>_HOME` from the
environment, then this method, then the refusal — which names both, so
the reader is not left to find out which of the two to set.

### `HostRoutingPaths` — where model routing keeps its files

Source: `src/host.ts`, `HostRoutingPaths`.

Where model routing keeps its files. Both are ACCOUNT-scoped, not workspace-
scoped, and that is why they do not come from `promptobusHome()`: that home is
the task store of one workspace, while auth, model inventory and the remaining
subscription limit belong to the account the harness binary is logged into. A
per-store cache would re-probe three harnesses for every checkout of the same
account.

`overlays` is ordered LOWEST precedence first, and the order is the host's to
choose. One method with a list rather than a getter per layer, because a
consumer will want a layer of its own — its shipped deny lists and defaults —
between the person's user-wide and workspace-local files: with a list that is
a host-side choice, with getters it is another change to this interface and a
repin for every consumer. `id` is what the decision output and `models
validate` name a layer by, so a refusal reads `denied by overlay "workspace"`
and not a path the reader has to place themselves.

A missing overlay file is normal. The host names paths; it does not promise
they exist.

### The binary version a host read, and what its absence means

Source: `src/host.ts`.

The binary's own version string as the host read it — the raw `--version`
line, not something normalised. Optional, and its absence means UNREAD: a
host that does not probe versions returns none, and a consumer may never
read that as "old".

The shipped standalone host is such a host. It hands the name back without
searching (`src/standalone.ts`), so under it the `ultracode` refusal never
refuses, the two proven-version warnings never warn, and an availability
verdict carries no version at all — that is the DEFAULT, not a rare case.

Declared here because four readers already exist and none of them could
name the field they read: the three drivers' `optionRefusal` and the three
availability adapters, which report it to a person as the verdict's
`version`. It is the drift `bin` above carries its comment about, one field
over — and load-bearing for a diagnosis rather than for a launch, which is
why it survived longer.
