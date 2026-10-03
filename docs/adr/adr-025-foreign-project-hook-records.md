# ADR-025: A participant lift accepts the tracker's hook records in a project's Codex and Cursor hook files

**Status:** Accepted
**Date:** 2026-10-03
**Deciders:** the repository owner, 2026-10-03: 1A, 2B and 3A.

## Context

backslop, from its v0.20.0, writes agent hook records into a project's own hook files when the project selects them in `backslop.json`: `.claude/settings.json`, `.cursor/hooks.json` and `.codex/hooks.json` at the project root. Each record runs `<cli> hook session-start|stop --harness <id>`, where `<cli>` is the `cli` field of that `backslop.json` (`hookCommand` in its `lib/hooks-install.js`). The files are committed, so every worktree a participant is lifted in carries them. Two drivers collide with that today.

**Codex refuses the lift.** `refuseForeignProjectLayer` (`lib/driver-codex.js`) throws when a `hooks.json` sits at the discovery path and is not a file this lift writes. For a linked worktree the discovery path is the main checkout's `.codex/hooks.json` (`projectHooksDir`), so a project that commits Codex hooks can run no Codex worker or approver.

**Cursor overwrites the file.** `prepare` (`lib/driver-cursor.js`) writes `.cursor/hooks.json` with the guard record alone into the participant's working directory. A tracked file there becomes a modified tracked file in the worker's tree, and the project's records do not run in that session. A Cursor or Codex approver would refuse instead: `approverLayer` (`lib/approver.js`) will not overwrite a launch file it did not write, and a tracked hooks file is one. That is read from the code, not run.

**What Codex loads from a linked worktree, measured 2026-10-03.** A throwaway clone committed a `.codex/hooks.json` holding two records of the tracker's shape; a linked worktree of it was the cwd; a participant-shaped home held the guard document in `hooks.json` and a trust record for the worktree. `hooks/list` on codex-cli 0.158.0 and on 0.159.0-alpha.12.1 listed four handlers: the guard's two from the home file (`source: user`) and the tracker's two from the main checkout's file (`source: project`), all `enabled`, all `untrusted`. A live app-server thread on 0.158.0, started with `bypass_hook_trust: true` in its `thread/start` config as the holder starts one, fired `hook/started` and `hook/completed` for `sessionStart` and for `stop` from both files, both at the same millisecond, both with the worktree as cwd. The source at tag `rust-v0.159.2` explains it: a project layer exists only when the cwd's `.codex` is a directory (`codex-rs/config/src/loader/mod.rs:1672`), a linked worktree reads that layer's hooks from the main checkout (`:1106`), every layer's `hooks.json` is loaded and only a repeated folder is skipped (`codex-rs/hooks/src/engine/discovery.rs:147`), and command handlers run concurrently with no deduplication (`codex-rs/hooks/src/engine/dispatcher.rs:125`). A tracked `.codex/hooks.json` makes the worktree's `.codex` a directory, so the project layer is always there.

**The same probe with the tracker's records copied into the home file** listed the tracker's `stop` and `sessionStart` twice each, once per source. Copying accepted records into the document the lift writes therefore runs them twice per event while the main checkout's file exists.

**What Cursor loads, measured 2026-10-03 on cursor-agent 2026.09.26-dd393fe.** The bundle builds the project hooks path as `<root>/.cursor/hooks.json`, where `<root>` is `git rev-parse --show-toplevel` or the nearest directory holding a `.git` entry — for a linked worktree, the worktree itself. A live `-p` turn in a worktree nested under its clone, with different marker commands in the main checkout's file and in the worktree's, fired `sessionStart` from the worktree's file only. That `-p` turn fired no `stop` from either file, so the `stop` location is read from the bundle, not seen; the persist session the driver uses was not run.

**Keeping a modified tracked file out of `git status`, measured on git 2.54.0.** With `git update-index --skip-worktree .cursor/hooks.json` in the worktree's own index, `git status --porcelain` was empty, `git add -A` staged only the other change, the commit carried only that change, and the main checkout's index entry kept no flag. A `git rebase` onto a main that had changed the same file failed: "Your local changes to the following files would be overwritten by checkout: .cursor/hooks.json", while `git status` showed nothing. `--assume-unchanged` failed the same rebase the same way. After `git update-index --no-skip-worktree` and `git checkout --` on that path, the same rebase exited 0.

**A record whose dependency is missing does not hold the turn, measured 2026-10-03 after the decision.** The owner then chose `npx --no-install backslop` as the `cli` of the three projects concerned. In a project made by the tracker's own `init` at v0.20.0, with no `node_modules` in the worktree or the main checkout, that command exited 1 after an `E404` from the registry. Codex 0.158.0 marked the record `failed` and still completed the guard and the turn; Claude Code 2.1.284 reported `outcome: error` and finished the turn; a Cursor `-p` turn answered. With `node_modules` in the worktree every record completed. A worktree nested under its clone resolves the main checkout's `node_modules/.bin` when it has none of its own. The commands and outputs are in [hooks and trust](../guides/hooks-and-trust.md#a-projects-own-hook-records).

**The trust bypass trusts whatever is accepted.** `bypass_hook_trust` runs every enabled handler from an enabled layer without the review `/hooks` asks of a person ([hooks and trust](../guides/hooks-and-trust.md#a-participants-hooks-are-not-the-workspaces)). A Cursor participant is lifted with `--trust`, and in the live Cursor turn above that flag was enough for the worktree's hooks to run without a prompt. An accepted record is therefore a command the participant runs at every session start and every stop with the participant's own permissions, chosen by the project's tracked files rather than by the owner. The project already chooses code a worker runs: the lift runs `npm ci` in the worktree with lifecycle scripts, and a worker runs the project's gates.

**The public audit does not stand in the way.** `npm run audit` exited 0 with a probe file in `lib/` naming `backslop.json`, `npx --no-install backslop` and one of the tracker's task identifiers: its forbidden list is the origin project's names, not those of the tools a consumer uses. Whether the code names the tool is therefore a choice of the rule, and the gate allows either.

## Options

**Decision 1 — which foreign records a lift accepts.**

- **1A — exact commands from `backslop.json`.** A record is accepted when its command `C` equals `<cli> hook <event> --harness <id>`, with `<cli>` the trimmed `cli` field of the `backslop.json` beside the judged hooks file, `<event>` `session-start` or `stop`, and `<id>` the harness that reads the file (`codex`, `cursor`), and when it sits under the event key that harness uses for that event. The record's form is the harness's own, with no other key: in Codex it is `{ "type": "command", "command": C }` inside a group that carries `hooks` and nothing else; in Cursor it is `{ "command": C }`, a record with `type` is not accepted, and the file may carry `version` beside `hooks`. Security cost: whoever commits both files chooses the command, so the rule keeps out a stray or unknown record, a record of another harness or event, and a non-command handler, but it does not keep out a hostile `cli`. A `cli` of the form `npx github:<owner>/<repo>#<tag>` fetches and runs that tag's code at every hook; `npx --no-install backslop` runs the worktree's installed dependency. Either runs without the owner's review.
- **1B — command shape alone.** A record is accepted when its command matches `<anything> hook session-start|stop --harness <id>`, without reading `backslop.json`, so the code never names the tool. Security cost: the prefix is any command, so the suffix is the only filter and the rule accepts arbitrary code on two events. Restricting the prefix to characters without shell operators still accepts any program on the path.
- **1C — an owner's list.** 1A, and the `cli` must also appear in a list the owner keeps in `promptobus.json`; a project whose `cli` changes refuses until the owner adds the new value. Security cost: the lowest of the three — a project cannot change what runs without the owner — but the code the `cli` resolves to is still unreviewed. Operating cost: a new configuration key, and an owner edit on every tracker upgrade that changes a versioned `cli`.

**Decision 2 — how Codex runs accepted records.**

- **2A — merge into the lift's hooks document.** Copy accepted records into the document the lift writes. Measured above: while the main checkout's file exists, Codex also loads it, and the records run twice per event.
- **2B — accept in place.** The refusal stands only for a discovered file holding a record 1 does not accept, and it names those records. An accepted file stays where it is and Codex loads it as the project layer; the lift writes the guard document to the participant home alone. For a linked worktree the lift no longer writes the worktree's `.codex/hooks.json`, which Codex does not read there, so a tracked copy stays unchanged and the approver's launch-file check passes. Cost: what Codex runs is the main checkout's working file at thread start, not at the check, so an edit made after the lift is not judged — the window the refusal already has today.

**Decision 3 — how Cursor runs accepted records.**

- **3A — merged file under `skip-worktree`.** Write the accepted records and the guard record to the worktree's `.cursor/hooks.json`, leave other records out, and when that path is tracked set `skip-worktree` on it in the worktree's index. Cost, measured: a rebase or checkout across a commit that changes that file fails while `git status` is clean, and a worker's own edit of that file never reaches a commit.
- **3B — leave a tracked file alone.** Do not write a tracked `.cursor/hooks.json`; the project's records run, and the session has no loop guard. Cost: a Cursor participant can end a turn with unread mail or an owed answer; only the warden's knock remains.
- **3C — refuse.** Refuse a Cursor lift when the hooks file is tracked. Cost: no Cursor participant in a project that commits Cursor hooks.

## Decision

**1A, 2B and 3A.**

1A because the boundary it draws is the one a worker already runs inside: the project's committers choose `npm ci` lifecycle scripts and gates, so trusting their `cli` adds no new author, while 1B trusts any command and 1C costs an owner edit per versioned upgrade for a guarantee the project's own scripts already void.

2B because 2A is measured to double the records, and accepting in place is the only arrangement in which each record runs once.

3A because it keeps both the loop guard and the project's records with a clean `git status`; its failure is loud, names the file, and needs an upstream change to that one file during a task.

## Consequences

- A project that commits the tracker's Codex hooks can run Codex workers and approvers; its records run in them without review, once per event, beside the guard.
- A Cursor worker or approver in such a project gets both the guard and the project's records, and its tree stays clean. A rebase across an upstream change of `.cursor/hooks.json` refuses until the bit is cleared, and [hooks and trust](../guides/hooks-and-trust.md#a-projects-own-hook-records) says how. A worker's own edit of that file does not reach a commit.
- The Codex refusal message lists the records it did not accept, not only the file.
- A new event, harness or command form the tracker adds is refused until this rule is widened by a new decision.
- `.claude/settings.json` is untouched: a Claude Code participant gets its guard through its own settings file. Cursor's bundle also reads hooks from the project's `.claude/settings.json`; a second live `-p` turn with that file in the worktree fired none of its records.
