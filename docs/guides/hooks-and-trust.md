# Hooks, trust, and troubleshooting

Current project hooks run one loop guard: Stop and SessionStart on Claude Code and Codex, and stop on Cursor. It refuses to end a turn with unread mail or an owed answer. Drivers also prepare participant hook files — see [A participant's hooks are not the workspace's](#a-participants-hooks-are-not-the-workspaces). This guide is for Claude Code, Cursor, and Codex.

Install removes a `PostToolUse` line that echoed each bus call into the session, wherever an earlier install wrote it. Nothing of the working machinery ran through that line: the turn is returned by the Stop guard, unread counts ride in the MCP reply itself, and delivery to a participant is the warden's over its own channel.

Install first: [install.md](install.md).

## What the installer edits

Only project files next to `promptobus.json`:

| Harness | File | Owned records |
|---|---|---|
| Claude Code | `.claude/settings.json` | `Stop` and `SessionStart` running `promptobus guard` |
| Cursor | `.cursor/hooks.json` | `stop` running `promptobus guard` only |
| Codex | `.codex/hooks.json` | `Stop` and `SessionStart` running `promptobus guard` |

`src/hooks.ts` plans the Claude-shaped settings; the installer maps that plan onto each harness file. Nothing generates a runner script any more. `.promptobus/hooks/bus.mjs` is the path an install still knows, because it is how it recognises and deletes a feed hook an earlier version wrote — and it deletes the script with it.

Owned records are identified by exact install ids first, not by file position. Guard records without a manifest id use the portable command signature described in [install.md](install.md); a leftover feed hook is recognised by the runner path its command still names. A later install with a shorter `--harnesses` list deletes owned records of the harnesses you dropped. Foreign groups stay, except guard-shaped commands described in [install.md](install.md).

## A participant's hooks are not the workspace's

`promptobus install` writes hook files at the **workspace root**. A worker works in its worktree, an approver in its own worktree, and a diff reviewer in a separate directory or sandbox. Teamlead and reporter sessions work at the install root (`lib/spawn.js:726`, `lib/report.js:180`). Drivers prepare participant hooks with that participant's identity (`--role`, `--task`, `--home`); the workspace guard carries none. A root hook can therefore also be in the project layer of a teamlead or reporter session.

For a Codex worker, reviewer or approver, that directory is also the only project the participant trusts: the lift records `[projects."<realpath of the working directory>"]` in the participant's home, and nothing else. In a reviewer sandbox the hooks file goes beside the skills copy, in `.codex/` of the working directory, under the same self-ignoring `.gitignore` that keeps a worker's diff clean. A worker's or approver's linked worktree gets it in the participant home instead, as described below. Managed Codex roots, teamleads and reporters use private homes with hooks disabled in both the home config and the thread config. Their holder and warden deliver turns through the app-server; they do not depend on project hooks at the install root.

**Measured 2026-09-12 on a live Codex reviewer, and the file alone is not enough.** The turn ran end to end — 45 journal lines, `thread/started`, `turn/started`, three `item/*` pairs — with the hooks file in the reviewer's working directory carrying its `--role`, and that directory named `trust_level = "trusted"` in the participant's home. No `hook/*` event of any kind appeared: `grep -c "hook/started"` was 0. The run does **not** distinguish a wrong location from the right one with hooks not enabled — `--dangerously-bypass-hook-trust` waives trust for *enabled* hooks, so enablement is a second gate and it was not tested. One thing it does rule out: the workspace-root file was not read either, since the guard there carries no `--role` and no such command ran. The file stays where it is because removing it would undo correct work if the gate turns out to be enablement rather than place.

**Follow-up measured 2026-09-12 on codex-cli 0.146.0, with the installed Promptobus copy at 0.7.0.** Three live participants each took two turns: `turn/started` was 2 and `hook/started` was 0 in every holder journal. Their process argv carried `--dangerously-bypass-hook-trust`; the worktree had `.codex/hooks.json`, and its `.codex/skills` directory had 59 entries. This closes the earlier installed-copy blocker. The flag is `PARTICIPANT_ARGV` in `lib/codex-session.js`; the installed holder file is a shim that imports that module, so a count of the name in the shim is 0 and does not mean the flag arrived by another path.

**The readable enablement checks were positive.** In the participant home, `codex features list` exited 0 and reported `hooks stable true`, `plugins stable true`, and `plugin_hooks removed false`. `--enable hooks` and `-c features.hooks=true` produced the same result. `codex plugin list --json` reported empty installed and available lists; the home's `plugins/` contained staging and cache directories, not an installed plugin. No enablement write or hook relocation was made: hooks were already effective in the feature readout. The six-turn live result still leaves the firing cause unnamed, and `features list` reads home state rather than the session's effective state, so this is not evidence that a human-only boundary exists.

**Where Codex keeps hooks and how it records trust, read off a working installation.** The owner's own `~/.codex/hooks.json` exists and has exactly the shape `install` writes — `{hooks: {PostToolUse, SessionStart, Stop}}` — so `CODEX_HOME` is one place hooks are read from. Trust is recorded separately, in `config.toml` of that same home, as `[hooks.state."<path>:<event>:<index>:<index>"]` carrying a `trusted_hash`. The keys on that machine name four different kinds of source: the home file itself, two PROJECT files under `<project>/.codex/hooks.json`, and plugin-provided ones spelled `<plugin>:hooks/hooks.json`. So a project's own hooks file is a source Codex knows how to trust, which is what makes the participant's working directory a plausible place rather than an obvious mistake.

**And trust is addressed by the file's path, which is what a participant has none of.** A participant lifts in a `CODEX_HOME` the driver builds fresh, holding `[mcp_servers]` and `[projects]` and nothing else — no `[hooks.state]` block at all. So whatever it discovers is untrusted by construction, and that is the gate `--dangerously-bypass-hook-trust` exists to waive. Two things remain unmeasured and are not asserted here: whether `app-server` honours that flag, as against merely accepting it, and whether a thread started through `app-server` discovers a project hooks file from its working directory the way an interactive session does. `[features]` in `config.toml` is unrelated — it holds `js_repl`, and the neighbouring `enabled = true` entries belong to `[plugins.…]`, not to hooks.

**Trust cannot be granted from outside, and that is a measured dead end rather than an untried idea.** Writing a `[hooks.state]` entry into a participant's home at lift would remove the need for the dangerous flag, but the entry carries a `trusted_hash` and what that hash covers is unknown: seven candidates were computed against a real entry — the whole file as bytes and as text, the hook group and the single hook each as compact and as key-sorted JSON, and the command string alone — and none matched. Until the input is known, the mechanism cannot pre-trust a file it wrote itself.

**And one measurement that decided nothing, recorded because the reason is instructive.** A lift on 2026-09-12 put the hooks file in the reviewer's working directory (1050 bytes, carrying its `--role`), with that directory recorded `trust_level = "trusted"`, and the turn ran to the end — 76 journal lines, eight `item/*` pairs. `grep -c "hook/started"` was 0 and no `[hooks.state]` appeared in the participant's home. It settles nothing, because the branch it ran on does not pass `--dangerously-bypass-hook-trust` at all: that argv change lives elsewhere and had not merged. The absent trust entry is therefore not evidence about discovery either — Codex writes such an entry when a person approves a hook, not for one it was never asked about.

**What enables a hook, read from codex-cli 0.156.1 at tag `rust-v0.156.1` (`b412ff32`).** The feature `hooks` is stable and on unless the config turns it off (`codex-rs/features/src/lib.rs`, `Feature::CodexHooks`, `default_enabled: true`). A handler is enabled unless its persisted state sets `enabled` to false (`codex-rs/hooks/src/engine/discovery.rs`, `hook_enabled`). It is added to the runnable set only when it is enabled and either trusted or the session has `bypass_hook_trust` (same file, the `handlers.push` condition). That flag is not a `config.toml` key: the config type says it is a runtime override (`codex-rs/core/src/config/mod.rs`, `bypass_hook_trust`). The CLI flag sits on the shared options the root command parses (`codex-rs/utils/cli/src/shared_options.rs`). The `app-server` subcommand never copies it into the server (`codex-rs/cli/src/main.rs`, the `AppServer` arm calls `run_main_with_transport_options` without it). App-server applies the boolean only when a request's config map contains `bypass_hook_trust` (`codex-rs/app-server/src/config_manager.rs`), and `thread/start`'s `config` map is that request (`codex-rs/app-server/src/request_processors/thread_processor.rs`, `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`). A person is not required: the same override is what the interactive client inserts when its own flag is set (`codex-rs/tui/src/app_server_session.rs`).

**Where the file is read, from the same tag.** Project `hooks.json` is `<layer>/.codex/hooks.json` (`codex-rs/hooks/src/engine/discovery.rs`, `load_hooks_json`). A linked worktree does not use the worktree's own folder: hook discovery is pointed at the matching folder of the main checkout (`codex-rs/config/src/loader/mod.rs`, `hooks_config_folder` and `root_checkout_hooks_folder_for_dir`). The user layer reads `$CODEX_HOME/hooks.json`, and that folder is not redirected. The holder therefore sends `bypass_hook_trust: true` on `thread/start`. A directory that is not a linked worktree keeps the document in its own `.codex/hooks.json`. A linked worktree gets it only in the participant home, written after the home is built and not among the launch files: Codex does not read the worktree's own file, and a tracked `.codex/hooks.json` there stays as committed. A reviewer sandbox is not a worktree, so its `.codex/hooks.json` is the file Codex loads. An approver runs in its own linked worktree, and its document goes to the participant home, as for a worker; the live SessionStart control is required before Codex approver lift is enabled.

**What the trust bypass trusts, and what refuses the lift.** `bypass_hook_trust` on `thread/start` trusts every project hooks file loaded from an enabled layer, not only the document this lift writes. Before that override, a file at the discovery path was inert, because the CLI flag never reached app-server. A file at a path this lift itself writes is its own, whatever its bytes: the reviewer sandbox is that path, and a later lift rewrites it. A linked worktree discovers the main checkout's file, which this lift does not write. That file lifts the participant only when the repository's `promptobus.json` trusts every record in it ([A project's own hook records](#a-projects-own-hook-records)). Any other record refuses, including a guard whose bytes match the document this lift writes, because Codex would load it as a project layer while the home copy ran the same guard again. The refusal is made before the worktree exists, so `--dry-run` refuses too; it names the file and every record it did not accept. Remove or move the file, or lift the participant on another harness. No file lifts as before.

**Codex walks project layers from the nearest `.git` down to the working directory.** `discover_project_layers` (`codex-rs/config/src/loader/mod.rs:1634`, tag `rust-v0.156.1`) collects `cwd.ancestors()` through `project_root` and then reverses that list, so the order is from the project root down to the cwd. The default project-root marker is `.git` (`codex-rs/config/src/project_root_markers.rs:5`). A directory that contains `.codex` is a candidate layer. Loading its hooks is a second decision.

**An ancestor layer loads only when that folder is trusted.** `decision_for_dir` (same file, `:1037`) looks up the directory in `[projects]`, then the project root, then the repo root. It is per folder, with that fallback: trusting the working directory does not trust its parents, and trusting the project root does trust a folder that has no entry of its own. `disabled_reason_for_decision` (`:1082`) disables anything that is not `TrustLevel::Trusted`. The reason names project-local config, hooks, and exec policies. Hook discovery iterates `layers_low_to_high` (`codex-rs/config/src/state.rs:548`), which omits a disabled layer, and only then reads `hooks.json` (`codex-rs/hooks/src/engine/discovery.rs:129`). `bypass_hook_trust` is applied when a handler already loaded from an enabled layer joins the runnable set (`discovery.rs:713`). It does not enable a disabled layer. The participant home sets `trust_level = "trusted"` only for `trustPath` of the working directory. A reviewer sandbox under the workspace is that directory. The workspace root is not, so the install file there is not loaded. The lift's refusal still checks the cwd layer and the main checkout of a linked worktree: those are the layers this trust record can enable, the main checkout through the linked-worktree hooks redirect.

**Measured on a Codex approver in a linked worktree on 2026-09-26.** A malformed clone-root `.codex/config.toml` stopped app-server before its thread started, even with an isolated participant home. With valid TOML at that path, `config/read` from the approver worktree did not add the clone-root file's MCP server and kept the participant home's conflicting `features.apps` value. A malformed `.codex/config.toml` one level above the clone Git root was not loaded by the same probe. Codex approver and worker lifts therefore refuse a malformed clone-root config before creating a worktree; a valid one may remain. Foreign clone-root hooks still refuse because hook discovery follows the linked worktree back to that checkout.

**Measured 2026-09-25 on codex-cli 0.156.1.** Three paid turns, and a spawn that failed before lift spent none. `~/.codex/config.toml` was hashed before and after each turn and the hash did not change.

A reviewer sandbox recorded `hook/started` and `hook/completed` for `sessionStart`. The path on those lines is that sandbox's `.codex/hooks.json`, and the command in that file contains `--role` for the reviewer. The participant home had no `hooks.json`.

A worker in a linked worktree, on a turn taken before the home copy was rewritten after the orphan sweep, completed a status and recorded no `hook/*` line. The spawn log had removed that home as orphaned before the session record named it. The worktree's own `.codex/hooks.json` was on disk; discovery does not load it.

The same worker shape, after that rewrite, recorded `hook/started` and `hook/completed` for `sessionStart`. The path on those lines is the participant home's `hooks.json`, and the command in that file contains `--role` for the worker. The main checkout had no `hooks.json`, so the journal names one source. A file at the main checkout is a second project source (`root_checkout_hooks_folder_for_dir` in the loader cited above); that case is measured in [A project's own hook records](#a-projects-own-hook-records).

`Stop` runs at the end of a turn that needs no follow-up (`codex-rs/core/src/session/turn.rs`, `run_turn_stop_hooks`). The 2026-09-25 journals above had no `turn/completed`, so their absence of `Stop` did not test that path.

**Measured 2026-09-26 on macOS with codex-cli 0.156.1.** A worker and a reviewer on
`gpt-6-sol` at low effort each ended a turn after sending a result. Both holder journals were read
after `turn/completed` and contain `hook/started stop` followed by `hook/completed stop` with
status `completed`, then `turn/completed completed`. The worker's two Stop lines name its isolated
Codex home's `hooks.json`; the reviewer's name its sandbox's `.codex/hooks.json`. Each file was read
before its session was stopped and contains a `Stop` guard command with that participant's `--role`.
The worker Stop lines are at 21:05:53.154Z and 21:05:53.307Z; the reviewer's are at 21:07:22.989Z
and 21:07:23.146Z. This proves the hook fires for these two finished turns;
it does not measure a turn that the guard returns for follow-up or a Codex approver.

## A project's own hook records

A project may commit agent hooks of its own in `.codex/hooks.json` and `.cursor/hooks.json` — a task tracker or another development tool installs them there — so every participant worktree carries them. A lift keeps the records the repository trusts in its own `promptobus.json` running beside its guard, and refuses or leaves out every other record ([ADR-025](../adr/adr-025-foreign-project-hook-records.md)). The tool that wrote the records needs to know nothing about Promptobus.

**Declaring trust.** The repository lists the exact commands under `trustedHooks`, by harness and by the event key that harness's hooks file uses:

```json
{
  "trustedHooks": {
    "codex": {
      "SessionStart": ["node scripts/session-note.mjs start"],
      "Stop": ["node scripts/session-note.mjs stop"]
    },
    "cursor": {
      "sessionStart": ["node scripts/session-note.mjs start"],
      "stop": ["node scripts/session-note.mjs stop"]
    }
  }
}
```

This is the repository's file, read by path beside the hooks file being judged: for Codex the main checkout's working file, the one beside the hooks file Codex runs; for Cursor the version in the worktree's index, the one its tracked hook records are merged from, so an uncommitted edit trusts nothing more. It is read as `generate` is ([03-cli § Spawn](../reference/03-cli.md#spawn)); the host is not asked. A missing file or field trusts nothing. A file that is not JSON or not a JSON object, or a `trustedHooks` entry that is not a map of event keys to arrays of command strings, also trusts nothing, and the refusal or warning names it. A file that holds only `trustedHooks`, `generate` or both does not move a standalone root, so the install root's `pipeline` still holds inside the repository; a host field in the same file makes the repository the root ([02-host § Standalone host](../reference/02-host.md#standalone-host)).

**Which records are kept.** A record is kept only when its command is byte-equal to a string listed for that harness and that event key, and the key is one a lift keeps: `SessionStart` or `Stop` for Codex, `sessionStart` or `stop` for Cursor. A Codex record is `{ "type": "command", "command": … }` inside a group that holds only `hooks`; a Cursor record is `{ "command": … }` and the file may also carry `version`. An extra key, a matcher, another handler type, another event, a command listed only for another harness or event, and a Promptobus guard command are each not kept, whatever the list says: the guard already runs from the lift's own document. A guard is any command in which a bare word `guard` follows a word naming promptobus, quoted or not, so `node /abs/promptobus.js guard` is refused as surely as the spelling `install` writes, and any command that carries the lift's own guard command after its launcher, through `guard`, compared word by word by file name — which covers a host whose guard argv names no promptobus. No tool's own configuration is read. `lib/project-hooks.js` holds the rule.

**What happens to the rest.** Codex loads the main checkout's file itself, so a lift cannot leave a record out of it: a record that is not kept refuses a Codex lift before the worktree exists, and the refusal names each such record, the declaration file and the keys to list commands under. A Cursor lift writes its own merged file, so it leaves such a record out and names it, with the same rule, in a warning.

**What that trusts.** A kept record runs at every session start and every stop, with the participant's permissions and without the review a person would give it: Codex runs it under `bypass_hook_trust`, and Cursor runs the project hooks of a workspace lifted with `--trust`. Whoever commits the hooks file and `promptobus.json` chooses the command. They already choose code a worker runs — the lift's `npm ci` and the project's gates — so the rule adds no new author; what it keeps out is a record nobody listed, another harness's record, another event, a non-command handler and a second guard.

**Codex.** Codex loads the main checkout's file itself, beside the guard in the participant home, so the lift does not copy kept records anywhere. Copying them into the home document would run each twice per event. Measured 2026-10-03 in a throwaway clone with such a file and a linked worktree as cwd: `hooks/list` on codex-cli 0.158.0 and 0.159.0-alpha.12.1 listed the guard's two handlers from the home file (`source: user`) and the project's two from the main checkout's file (`source: project`), all `enabled` and `untrusted`. A live app-server thread on 0.158.0, started with `bypass_hook_trust: true` as the holder starts one, recorded `hook/started` and `hook/completed` for `sessionStart` and `stop` from both files, with the worktree as each command's cwd. With the project records also copied into the home file, `hooks/list` listed each of them twice. The source at tag `rust-v0.159.2` loads every layer's `hooks.json` and runs command handlers concurrently without deduplication (`codex-rs/hooks/src/engine/discovery.rs:147`, `codex-rs/hooks/src/engine/dispatcher.rs:125`).

**Cursor.** Cursor reads `.cursor/hooks.json` at the root of the worktree it runs in, not at the main checkout. The bundle of `cursor-agent` 2026.09.26-dd393fe takes that root from `git rev-parse --show-toplevel` or the nearest `.git`, and a live `-p` turn in a nested worktree fired `sessionStart` from the worktree's file and not from the main checkout's. That turn fired no `stop` from either file, and the driver's persist session was not run. So the lift writes the worktree's `.cursor/hooks.json` as a merge: the guard on `stop`, then the kept records, and nothing else. It merges from the tracked content in the index, so a relift does not read its own earlier write; every record it leaves out is named in a warning. When the path is tracked, the lift sets `git update-index --skip-worktree` on it in the worktree's own index: `git status --porcelain` stays empty and `git add -A` does not stage the merged bytes. An approver accepts that path while it still holds the tracked blob, hashed as `git add` would hash it, so a checkout conversion such as `eol=crlf` is not an edit; an edited copy and any other pre-existing file still refuse.

**The price of `skip-worktree`, measured on git 2.54.0.** A rebase or checkout across a commit that changes `.cursor/hooks.json` fails with "Your local changes to the following files would be overwritten by checkout: .cursor/hooks.json" while `git status` shows nothing. A worker's own edit of that file never reaches a commit. To recover in that worktree, run `git update-index --no-skip-worktree .cursor/hooks.json` and `git checkout -- .cursor/hooks.json`, then repeat the rebase; a relift writes the merge again.

**A record whose dependency is missing does not hold the turn, measured 2026-10-03.** A throwaway project ran a task tracker's own `init` at v0.20.0 with `cli` `npx --no-install backslop`, and a worktree nested under the clone, as the bus places one. With `node_modules` neither in the worktree nor in the main checkout, `npx --no-install backslop` exited 1 after `npm error code E404` from the registry. Codex 0.158.0 under `bypass_hook_trust` marked that record `failed` ("hook exited with code 1") on `sessionStart` and `stop`, completed the guard beside it, and reached `turn/completed completed`. Claude Code 2.1.284 in `-p` reported the record's exit 1 as `outcome: error`, ran the guard, and finished the turn with `result success`. A Cursor `-p` turn answered and exited 0. With `node_modules` in the worktree every record completed, and the tracker wrote its session record in the worktree's Git directory. A worktree with no `node_modules` of its own still finds the main checkout's: `npx --no-install` resolved `<clone>/node_modules/.bin/backslop`, so the record then runs the version installed in the main checkout.

**Not measured.** Cursor's `stop` in a persist session; the exit code of a Cursor record, which `-p` does not print; `npx --no-install` without network; and whether Cursor runs hooks from the project's `.claude/settings.json`, which its bundle also reads — the live `-p` turn above ran none of them.

## What is never touched

- `~/.claude`, `~/.cursor`, `~/.codex` — user-level harness homes
- Foreign hook groups that are not guard-shaped, and unknown fields in the project files
- Hooks that are not owned by Promptobus
- The participant worktree's main tree outside the hook the driver writes

`uninstall` is the same rule in reverse: owned Promptobus records only.

## How to verify

```bash
promptobus install --check
```

`--check` does not repair. Non-zero exit means project files drifted from the last install. Re-run `promptobus install` (no flags, or the same `--harnesses` list) to write them again.

```bash
promptobus install --dry-run
```

Prints the plan. Writes nothing. Use it before the first write.

Idempotence: a second install with the same list must not change bytes. If `--check` is red after a no-op install, the merge is wrong — file a finding, do not hand-edit the matcher.

From a subdirectory of the workspace, hooks still run against the workspace root the host found. If they do not, `promptobus.json` is missing above you, or `PROMPTOBUS_HOME` points at another store.

## How to trust

The installer does not bypass harness trust. After a successful write the CLI prints `configured` and:

```text
Review: Codex requires /hooks; project hooks also depend on workspace trust.
```

**Claude Code.** Project hooks in `.claude/settings.json` run only when this workspace is trusted. Approve the project when the harness asks. The Stop hook is `promptobus guard`. A clean mailbox exits 0 and prints nothing. Unread mail exits 2 and returns the turn.

**Cursor.** Project hooks live in `.cursor/hooks.json`. Trust the workspace hooks when Cursor asks. Bus feedback reaches a Cursor participant by driver injection, not a project hook. The loop guard is `stop`. An unknown event name in `.cursor/hooks.json` silently disables every hook in the file, so do not add one by hand: the names Cursor knows are the bundle inventory in [03-cli](../reference/03-cli.md#cursor-hook-events), of which five are proven live. A name from the other sixteen already in your file installs, with a warning: it is one build's dictionary, and a build that does not know the name disables every hook in the file in silence. The installer validates the merged event map before writing and refuses an unknown event.

**Codex.** Review the new project hooks with `/hooks` before you rely on them. Project hooks also depend on trusting this workspace.

If you skip trust, spawn still works, but project hooks do not run: each harness loses its project Stop guard. The warden can still knock. `promptobus_mailbox` is still the source of truth.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `promptobus help` has no `install` | This binary was built before the hook installer merged. Do not hand-copy hook JSON. Use the `install` command from a build that lists it in help. |
| `--harness X` refused | `X` is not in `promptobus.json` `tools`. Add it. Do not invent a `tools add` command — this CLI has none. |
| MCP tools missing | The session has no `promptobus` stdio server, or `PROMPTOBUS_HOME` is wrong. Compare the path with `promptobus status`. |
| Foreign mailbox header | You resolved another task. Pass `task` to the tool, or `promptobus_mailbox` with `claim: true` if this is your task and a new session. |
| Stop hook loops | Guard returns 2 at most twice on the same unread set, then warns and lets the turn end (`lib` guard). Empty the mailbox. Do not delete the Stop hook to "fix" a loop. |
| Warden silent | `PROMPTOBUS_WARDEN=off`, or the participant is on `self-wake` in `promptobus status`. Three different things end there, and the line now says which: `starting up` is the participant not having handed over a contact point yet and clears on the first knock; a contact point held by another session clears when the address's own session takes it back; a channel that refused stays until the channel accepts. Mail is in the mailbox either way — call `promptobus_mailbox`. |
| Worker worktree has no Stop hook | The driver writes that hook at spawn, not `promptobus install`. Re-spawn the participant. |
| Partial hook file after a crash | The installer must refuse a malformed file and write nothing. Restore the file from git and run `promptobus install --check`. |
| Home-directory hooks changed | That is a bug. Project install never writes under `~/.<harness>`. Report it with the path and a diff. |

### The three `self-wake` states

Source: `lib/status.js`, `SELF_WAKE_PROGNOSIS`.

The warden falls back to `self-wake` from three branches and records which one in the health mark (`selfWake`, written by the round in `src/supervisor.ts`). They share a label and nothing else, so `promptobus status` prints the prognosis after the reason:

| State | Reason it prints | Prognosis | How well it is known |
|---|---|---|---|
| `starting` | no contact point handed over | clears on the first knock | verified from a run journal |
| `taken` | the contact point is held by another session | clears when the address's own session takes it back, and not at all if that session is gone | the round expects the rewrite at that session's next end of turn, and the suite checks that delivery resumes after it |
| `refused` | the driver's channel did not accept the notification | it stays until the channel accepts | retried, so it clears if the channel returns — but nothing in the mechanism makes it return |

Only `refused` has a channel to name, and it is named the way the warden journal names it — `socket` for Claude Code, `inject` for Cursor, `rpc` for Codex.

Why the prognosis is printed at all: without it the label reads as a break in every case, and it is not one in two of them. Measured on 2026-09-10, before the field existed — the orchestrator of that run read the start-up label on its own address as a broken channel and went looking for the break.

A health record written before the field carries no `selfWake`. The prognosis is then not said rather than guessed, with one exception the wake record settles on its own: no contact point handed over at all is the start-up state whoever wrote the health file, and it is also what an address the warden has not yet reached looks like.

A postcard is not a read: it names each message by its stub, never its text. Only `promptobus_mailbox` marks mail read. If a knock repeats, the mailbox still has unread items.

## Related

- Command form: [install.md](install.md)
- Host boundary: [../adr/adr-002-standalone-host-contract.md](../adr/adr-002-standalone-host-contract.md)
- Orchestrator skill: [../../skills/orchestrate/SKILL.md](../../skills/orchestrate/SKILL.md)

## When a stall is a stall

Source: `stallStands` in `src/supervisor.ts`, the one predicate behind the warden report, the `promptobus status` print and the stalled lines in a `mailbox` reply.

Whether this is a stall for real. While the bus still had awaiting, the
participant sat inside a tool call between messages and was busy to the
harness; once awaiting was removed, they finish the turn after sending a
message, and the harness marks their session as standing with a line like
"result sent; awaiting next cycle". For stall inspection that is an
`unknown` outcome, and a report went out on every ordinary end of turn.

What remains a stall is a SILENT end of turn: the participant finished the
turn without sending anything on the bus after their last activation.
`limit` is not subject to this check at all — time lifts it, not a message
on the bus.

`permission` has a check of its own. A harness reports a
dialog through ONE field, and it puts two different dialogs behind it: a
permission prompt of the session's own work, and a peer message the session
HELD rather than delivered — which is what the bus's own postcard becomes
when a participant is lifted in a mode that bypasses prompts. A driver's
measurement of that is in its own file, where the tool's name is allowed to
be; what belongs here is the shape it leaves: the record is identical to a
real prompt while the session runs its turn to the end and answers.

Nothing in the record tells the two apart; the bus's own marks do — **a
prompt is what SUSPENDS a turn**, so a participant that both ended its turn
and spoke after its last activation was not stopped by the dialog standing on
it (`promptStands` in `src/supervisor.ts`). It is still deaf to that message, and the bus has
its own words for a deaf channel; what it must not do is call a person to a
session that is working.

One predicate for three callers: the warden report, the `promptobus status`
print, and the stalled lines in the `mailbox` reply. If they drifted, they
would become different answers about the same state.

The task and its store are required arguments, and they have no silent
default on purpose: "no home — treat as a stall" is exactly the divergence
mechanism the predicate was collapsed into one function to close.

## The warden state machine: what is here and what is not

Source: `src/supervisor.ts`.

The warden state machine: rounds, knock-retry thresholds, unread health,
silence escalation, and the decision of whom to activate.

What is here and what is not. Here — DECISIONS: who still has unread, whether
it is time to knock, which messages to show, who stalled, and who has already
been reported. There is no delivery channel here, and no text: the channel
comes from the driver via `activate`, and the same driver renders the text —
the frame and the words belong to the harness channel, not the bus. There is
also no process here: the detached launcher, the `fs.watch` observers, and the
loop live at the consumer, because a process death costs nothing by
construction — the entire state sits in the task store.

The intervals this machine runs on are not in this guide: `TICK_MS`,
`KNOCK_RETRY_SEC`, `KNOCK_COALESCE_SEC`, `SILENCE_SEC`, `WARDEN_TOTAL_SEC`, `WARDEN_ABSOLUTE_SEC`,
`ROUND_FAIL_LIMIT` and `SPAWN_GRACE_SEC` stand together at the top of
`src/supervisor.ts`, each
above the line that states what it was measured by. They are measured and
not chosen, and changing one changes the behaviour of a live run. What
follows here is the decisions those numbers feed.

### `wakeTakenBy` — the address's contact point is held by a FOREIGN session — or null if

Source: `src/supervisor.ts`, `wakeTakenBy`.

The address's contact point is held by a FOREIGN session — or `null` if
it is held by its own, or there is nothing to compare.

This is not malice: the Stop hook takes identity from its command
arguments, and when they are missing — from the session environment, and
the harness background-session environment is not the one the session was
spawned with. Measurement 2026-09-03: harness background sessions are
pre-allocated daemon spares, and the `PROMPTOBUS_*` trio comes to them
from the process that raised the daemon, that is from the FIRST spawn of
the run. The second participant of the task then hands over a contact
point for the first address, and the warden, checking nothing, wakes a
foreign session through it: in ten minutes of that run eleven
notifications went to the wrong place.

Hence the rule: do not knock on such a contact point. It is not dead —
it leads to another session, and a knock on it starts a FOREIGN turn,
while the addressee stays deaf. This repairs itself on the first end of
turn of the real owner: their hook rewrites the record with their own.

Both sides must be named: a participant record without a session id
(spawn did not parse it from `--bg` output) and a contact point of the
former CLI without a `session` field — that is unknown, not a foreign
session, and it cannot be blamed.

### `promptStands` — whether a dialog mark is a permission prompt the participant is standing at,

Source: `src/supervisor.ts`, `promptStands`.

Whether a dialog mark is a permission prompt the participant is standing at,
or the bus's own postcard held behind the same field.

**Two marks have to agree, and neither alone lifts the stall.** A participant
whose dialog is the held postcard never saw the message: it carried on with
the turn it was in, reached the end of it, and reported — so after its last
activation the bus has BOTH its end-of-turn mark and a message from it. A
participant standing at a prompt of its own work has neither: the prompt is
what suspends the turn, so the Stop hook has not run and nothing was sent.

The conjunction is deliberately narrower than either half. The end-of-turn
mark alone would read the stand's play of a dialog — which runs the guard —
as a held message; a sent message alone would silence a real prompt hit later
in a turn that had already spoken. What is left open is a turn begun without
an activation: the bus does not start one, and a person who does is at the
session already.

Missing marks keep the stall, each for its own reason: no end-of-turn mark
means the participant has never yielded a turn, and reading that absence as
"carried on" would silence the very first prompt of a run; a participant
record too broken to read messages from has no right to lift its own report.

### The warden is a process, not a state machine

Source: `lib/warden.js`.

The task warden is a PROCESS, not a state machine.

Listening on the bus is held by a process, not by model discipline: the warden is
the only listener of every task mailbox and its only activator. On unread mail it
wakes the addressee and thereby starts their turn. The process has no state of its
own — everything lives in the task store, so its death loses nothing, and any CLI
command may start it again (`ensureWarden`).

**This file does not make the decisions.** Rounds, knock-retry thresholds, unread
health, silence escalation, stall resolution, and the "whom to activate" decision
live in the package ([supervisor.ts](../../src/supervisor.ts)) and know nothing about
the harness. What remains here is exactly what belongs to the harness and the
workspace: a detached process, `fs.watch` watchers, a session snapshot through the
driver registry, human diagnostics, and the loop. The delivery channel is the
driver, and it is taken from the registry
([drivers.js](../../lib/drivers.js)).

Delivery is best-effort: the "delivered" mark is one, the mailbox is claimed. An
activation refusal does not kill the process: the participant is marked with the
`self-wake` channel, and delivery to the rest continues.

### `sessionBusy` — whether the participant's session is busy with a turn

Source: `src/supervisor.ts`, `sessionBusy`.

Whether the participant's session is busy with a turn. There are two
branches, because there are two kinds of participant, and one branch
is not enough for both.

**There is a session reference** — take busyness from the snapshot: the
driver declared it.

**There is no reference** — that is how the task owner lives: their
session was not raised by the driver, and the harness has no record of
it at all. Busyness is then taken from the cycle watchman: it is called
on EVERY end of turn and lays a mark (`markTurn`). An activation newer
than the mark means that since then the session started a turn and has
not yet given it back. The signal is cumulative, not instantaneous:
"has it been free since the last activation", not "is it free this second".

Neither source is a contract: no snapshot, no record, the watchman mark
has never been laid — that is UNKNOWN, not busy, and the caller does
what they would have done without the predicate.

**The watchman signal is bounded, and one state outlives the bound.**
Past `SILENCE_SEC` of unread mail the warden stops asking `sessionBusy`:
a knock dropped by a queue limit never starts a turn, so the mark never
moves, and "busy" would hold the retry for ever. A turn held on a
question to its user looks exactly the same from here, so the retry
asks `awaitingUser` below instead.

### `awaitingUser` — whether the turn waits on its user

Source: `src/supervisor.ts`, `awaitingUser`; `lib/guard.js`; the Claude
driver's `awaitsUser` ([05-drivers.md](../reference/05-drivers.md#awaitsuser--whether-a-claude-transcript-holds-an-open-question)).

The guard records the hook input's `transcript_path` from the session's
start and again on Stop, for its address, together with the session that
sent it (`waits/<address>.transcript.json`). The payload field is documented in
the Claude Code hooks reference
(<https://code.claude.com/docs/en/hooks>, common input fields); the Stop
and SessionStart hooks are already installed — install writes both — so
no workspace setting changes. The retry
asks the address's driver whether that transcript holds a question to
the user that has no answer yet. While it does, the `KNOCK_RETRY_SEC`
retry is withheld (03-cli § Guard and warden). The first knock for new
mail is not.

**Why the transcript and not a hook.** Measured on Claude Code 2.1.280,
three interactive sessions with logging hooks on every event:
`PreToolUse` fires with `tool_name: AskUserQuestion`, then `Notification`
`permission_prompt` about six seconds later, and nothing else while the
question is open. An answer brings `PostToolUse` for the tool and then
`Stop`. A question declined with Esc brings NO hook at all — no
`PostToolUse`, no failure event, no `Stop` — so a mark laid by
`PreToolUse` would stay up over an idle session. The transcript does
record the decline: a `tool_result` with `is_error` and a user line.

**Withholding needs positive evidence.** The answer is "open" only when
the transcript tail holds an `AskUserQuestion` `tool_use` with no
`tool_result` after it. Every doubt is "not open", and the retry goes
out as it would without the predicate:

- no recorded path;
- a path recorded by a session other than the one behind the contact point;
- an unreadable file, or lines that do not parse;
- a record shape the reader does not know;
- a tail that does not reach the question;
- a driver without the operation.

A session that died with its question open keeps its transcript open.
The hold then stays, but there is nobody to knock: the contact point is
dead, and `SILENT` has already been written once.

### `lastActivation` — when the participant was last REACHED

Source: `src/supervisor.ts`, `lastActivation`.

The newest of three marks that all mean the participant was reached: the
record's `started`, the health `knockedAt`, and the health `deliveredAt`. A
failed activation (`triedAt`) is left out — silence after it speaks of a deaf
channel, not a stall. `null` means none of the three parses.

**Three predicates read it, and they do not read it for the same thing.**
`stallStands` and `promptStands` compare it with the participant's last SEND,
and `null` there means "nothing to compare against" — the stall stands.
`sessionBusy` reads it only on the branch for a participant with no session
reference, compares it with the last END OF TURN rather than with a send, and
on `null` answers `false`: nobody who was never reached is mid-turn.

**It is exported for the sake of checks, and that is the whole of the
addition.** A check that asserts "this participant is not stalled" has to
establish the same order the predicate compares, and a private maximum over
the three marks, written inside the check, drifts from the predicate it exists
to guard the moment a fourth mark is added or one is dropped. The scenario's
step 7 takes it through `lib/status.js`, by the same import as `stallStands`.

### `stallStands` — the grace window before a participant has ever spoken

Source: `src/supervisor.ts`, `stallStands`.

The participant has NEVER yet spoken on the bus, and their session already
shows a finished turn — that is an unfinished start, not a stall. The
window opened together with the new entry into the inspection: while
`blocked` served as that entry, a fresh session never landed in it at all,
and it shows `idle` between `--bg` and its first turn — a report would
have gone out with the reason literally `idle`, because `state.json` has
not been written yet by then.

**The window sits inside the predicate, not in `blockedParticipants`
next to the neighbouring `justSpawned`, because the `promptobus status`
print calls the predicate directly, bypassing participant inspection**
(`lib/status.js`) — put there, it would have left that print unprotected
and split the channels, exactly against what the predicate was collapsed
for.

**And only this branch: a participant who has spoken at least once has a
real timeline, and silence after activation is a stall regardless of the
record's age**; a window over the whole `unknown` branch would have given
half a minute of deafness to everyone at once.

**A knock that lands after the reply makes the stall stand again, and that
is the contract, not a defect.** `since` is the newest of the three
activation marks and `sent` is the participant's last message, so a
re-knock on the warden's own retry threshold moves `since` past `sent` and
the same finished turn becomes a stall. It has to: the question the branch
asks is whether anything came back since the last time we reached them, and
a fresh un-answered knock has had no answer. The consequence belongs to
whoever writes a check. **A verdict that asserts "this participant is not
stalled" owes itself the precondition `sent >= since`, waited for and
asserted on its own line** — without it the verdict races the warden and
goes red on sound code. Measured by hand on a store with the
stamps set, 2026-09-17: one reply, one end of turn, and the answer flips
with the knock's stamp alone — a knock 60 s after the reply gives `true`,
a knock 60 s before it gives `false`.

### `wardenRound` — one watch round

Source: `lib/warden.js`, `wardenRound`.

One watch round. A wrapper over the state machine: a session snapshot arrives here,
the registry leaves from here. `knock` is a suite seam: a stand-in driver for one
round.

**The round does not request a snapshot and has no right to.** It arrives as an
argument and is held in a loop variable until the heartbeat; the round runs once a
second, and a snapshot stands on a harness-query process launch. Measurement 2026-09-02
(count by argv of a stand-in binary, three participants with sessions): the round —
0 launches of `claude agents --json` both with a snapshot and without; the
heartbeat — 1, both on a parsed reply and on an unparsed one.

The cost of an "improvement" is there too, but it is counterfactual: if the round
took state itself and WITHOUT a cache reset, sixty snapshots (a minute) would cost
1 launch on a parsed reply and 60 on an unparsed one — a parse refusal is not
cached on purpose ([liftoff.js](../../lib/liftoff.js)).
Nobody pays that cost today: the snapshot dies on the FIRST `null`, and the loop
resets the cache itself before the heartbeat snapshot.

The loop variable holding it starts as `undefined`, meaning "not taken yet", and the
very first round takes it from INSIDE the guard rather than before it. A refusal
raised before the guard would carry the process past `finally` — without clearing the
mark and without a journal line — and the next bus command would start a warden into
the same death. `null` from a snapshot is a legal state and is not re-taken.
