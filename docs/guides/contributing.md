# Contributing

This repository is run entirely through [backslop](https://github.com/Velklish/backslop) `v0.3.0`. There is no issue tracker beside it. The pin is `backslop.json`.

```bash
npx github:Velklish/backslop#v0.4.0 status
npx github:Velklish/backslop#v0.4.0 lint
```

English is the language of new strings, comments, commit messages, and checks. `README.ru.md` is the only file that may use Cyrillic.

## Roles

| Role | Steps | Must not |
|---|---|---|
| Worker | 1–4: change, document, run gates | Declare the work accepted; move files in `docs/backlog/` or `docs/archive/` |
| Approver | 5–7: review, archive, triage, commit to the main line | Write the worker's code |

One agent may play both roles in order. Under orchestration they are different sessions. The worker commits on the assigned branch and stops.

Procedure text lives in `AGENTS.md` (backslop block) and in the `backslop-task` / `backslop-batch` skills that `backslop init` laid out for the selected adapters.

## Worker path

1. **Take the first queued task** from `status`, or create one:
   - `npx github:Velklish/backslop#v0.4.0 new <slug> --title "…"` → triage
   - add `--queue` to put it in the queue
   - A tiny change that does not alter a contract may skip a tracker file if one pass finishes it.
2. **Change the code.** Reverse a prior decision by deleting it. Do not strike through. Use [glossary](../GLOSSARY.md) names. If a name is missing, propose a row.
3. **Document in the same pass.** Update the matching [reference](../reference/README.md) section, this guide if the workflow changed, and `CHANGELOG.md`. An architectural choice needs `npx github:Velklish/backslop#v0.4.0 adr <slug>` and a row in [docs/README.md](../README.md).
4. **Gates on an unchanged tree.** Commands in `backslop.json` `gates` must exit 0. Today that is `npx github:Velklish/backslop#v0.4.0 lint`. Also run `npm test` when you touch runtime code. A test change needs a mutation probe: commit first, then break the assertion, then revert. A gate with an early cutoff needs a second probe that feeds a false positive.

Report: what changed, how you verified it (numbers and exit codes), what you left open, findings outside the task. Open a finding with `npx github:Velklish/backslop#v0.4.0 new <slug> --parent N` and evidence. Do not push. Do not edit the repository's main tree from a worktree.

Commit subject: `PB-N: <what was done>` when the change has a task number.

## Approver path

Review the diff. Then archive and triage in one pass:

```bash
npx github:Velklish/backslop#v0.4.0 archive N
```

Fill `docs/archive/<id>-<slug>/result.md` (outcome, what was done, verification). `[TODO]` in that file fails lint. Review every `triage/` entry: merge, clarify, `mv N queue`, or `mv N deferred` with a return condition. Ask the owner only before rejecting.

A task reaches the default branch as one commit. Intermediate worker and review commits are squashed before that push.

## Skills

| Skill | When |
|---|---|
| `backslop-task` | One backlog task, take through archive |
| `backslop-batch` | Several tasks, tracks, review gate |
| `backslop-seed` | Fill glossary / roadmap / reference after `backslop init` |
| [orchestrate](../../skills/orchestrate/SKILL.md) | Split work across worker sessions on this bus |
| [solo-review](../../skills/solo-review/SKILL.md) | Isolated read-only review of one diff |

## Suite isolation

The suite runs on a machine that is not its own: a person's binaries and sessions are there, and a second `npm test` — a worker run by tracks puts one per worktree — may be going at the same moment. Four rules keep a run from reading or touching anything but itself. Each is enforced by a check, because each was broken in silence first.

**Every sandbox prefix is on the sweep list.** A run that is cut off — Ctrl-C, a file taken down at the file timeout, a crash — never reaches its own cleanup, and the leftovers are removed by the sweep at the start of the next run ([test/tmpdir-sweep.mjs](../../test/tmpdir-sweep.mjs)). The sweep only knows the prefixes in `SUITE_PREFIXES`, and that list is hand-built, so a sentinel in `tmpdir-sweep.test.mjs` greps `test/` for every `makeSandbox('…')` and every `mkdtemp` of a temp directory and demands the list cover them. The grep takes both spellings of the directory — `os.tmpdir()` and an imported `tmpdir()`, `path.join` and a bare `join` — because while it demanded the qualified one, a file that imported `tmpdir` was invisible to it and its prefix leaked past the sweep with the check green. Adding a sandbox with a new prefix means adding the prefix; the sentinel says so on the next run.

**Every suite file diverts home at module load.** The runner gives each file of a run its own home, so a run started with `npm test` never touches the operator's. A file run BY HAND has no runner, and that is the case the diversion is for: it applies the shared hygiene list — home, the warden switch, the session-leak names, the memory-hook lever, the `PATH` seal — from [test/home.mjs](../../test/home.mjs), and every `test/*.test.mjs` imports it **before any module that is not a Node built-in**, because one that resolved a home path at load would see the real one. A built-in captures nothing, so `node:fs` above the line is not the hazard. The verdict helper [test/check.mjs](../../test/check.mjs) imports it first in turn, so a file that names the helper is covered and needs nothing else. `home.mjs` borrows nothing itself — the sandbox is written out in it rather than taken from `sandbox.mjs`, which statically imports three package modules — and the sentinel checks that too. The apply used to live in the helper, which meant it reached only the files that wanted a verdict printer: the 22 written against `node:test` had nothing, and the two of them that actually wrote under home carried a copy of the diversion each. A sentinel in `tmpdir-sweep.test.mjs` reads the directory and refuses a suite file that imports neither, and checks that the helper really does import the apply point — otherwise "naming the helper is enough" would be a claim rather than a fact.

**A machine-wide read is scoped by something the run owns.** A second `npm test` on the same machine is the normal state — a worker run by tracks starts one per worktree — and per-file sandboxes do not separate two runs in the process table, on a tmux server, or in `/tmp`. Every such read must be qualified by a path, a pid or a mark that belongs to this run alone; a program name is not one. The register of the reads the suite makes today, and what each is scoped by, is in the header of [test/run.mjs](../../test/run.mjs), beside the serial group.

**PATH is sealed; an unstubbed binary name resolves to nothing.** Sandboxing `HOME` and `TMPDIR` seals nothing by itself — a child process escapes through `PATH`. The runner hands every suite file a `PATH` of one directory, holding a symlink per binary in `REACHABLE_BINARIES` ([test/hygiene.mjs](../../test/hygiene.mjs)): `ast-grep`, `env`, `git`, `node`, `npm`, `pgrep`, `ps`, `sh`, `sleep`, `tar`. Nothing else is reachable, and in particular no harness binary is — `claude`, `cursor`, `cursor-agent`, `agent`, `codex` and `tmux` are absent on purpose. A file that needs one stubs it (`stubCommand` + `withStubPath` in [test/sandbox.mjs](../../test/sandbox.mjs), which prepend to the sealed value rather than replacing it); a file that forgot gets ENOENT naming the command, which is the outcome the seal exists for. Adding a name to the list means saying in the comment beside it which check needs it.

One consequence to know rather than rediscover: refusal paths that used to reach a real binary now report "not found in `PATH`" under the suite. The Cursor driver's `tmux` resolve is the visible one — it refuses instead of talking to the machine's tmux, which is the intended reading of that branch.

**A run leaves no process behind.** Two run-level gates at the tail of [test/run.mjs](../../test/run.mjs) say so, and they are mirror images. A warden may not be auto-lifted at all, so that gate judges the ACT: the lift point appends a line to the run's warden trace, and any line is a failure. A Codex holder is started on purpose — the Codex file lifts real participants — so its gate judges the MOMENT: the driver appends the pid and the session file at every holder start, and the tail refuses a holder still alive when the run ends, matching the pid against the session file in its live argv because the system reuses process numbers. A holder reaps itself once its session record goes, and the record goes with the run directory, so a red gate means a holder was still holding a live session. Neither gate kills anything; both name what is left.

The seal is watched, not assumed. Every command the package launches through `run` is appended to the run's resolve trace ([lib/exec.js](../../lib/exec.js), variable `PROMPTOBUS_EXEC_TRACE`), and the runner refuses a run in which any of those paths lies outside its own run directory. A name that resolved to nothing is not counted — that is the seal working. The boundary is `run` itself: a test file that calls `spawnSync` on its own does not pass through it and is not traced; those calls are `process.execPath` and stub binaries inside the file's own sandbox, and the route the gate exists for is the one through the bus boundary.

## Public surface

Do not add internal product names, private package scopes, or links into another repository's `docs/`. Examples in tests and docs use a fictional workspace. See the publicity checks in the project gates when they land.
