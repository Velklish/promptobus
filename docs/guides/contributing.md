# Contributing

This repository is run entirely through [backslop](https://github.com/Velklish/backslop) `v0.3.0`. There is no issue tracker beside it. The pin is `backslop.json`.

```bash
npx github:Velklish/backslop#v0.3.0 status
npx github:Velklish/backslop#v0.3.0 lint
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
   - `npx github:Velklish/backslop#v0.3.0 new <slug> --title "…"` → triage
   - add `--queue` to put it in the queue
   - A tiny change that does not alter a contract may skip a tracker file if one pass finishes it.
2. **Change the code.** Reverse a prior decision by deleting it. Do not strike through. Use [glossary](../GLOSSARY.md) names. If a name is missing, propose a row.
3. **Document in the same pass.** Update the matching [reference](../reference/README.md) section, this guide if the workflow changed, and `CHANGELOG.md`. An architectural choice needs `npx github:Velklish/backslop#v0.3.0 adr <slug>` and a row in [docs/README.md](../README.md).
4. **Gates on an unchanged tree.** Commands in `backslop.json` `gates` must exit 0. Today that is `npx github:Velklish/backslop#v0.3.0 lint`. Also run `npm test` when you touch runtime code. A test change needs a mutation probe: commit first, then break the assertion, then revert. A gate with an early cutoff needs a second probe that feeds a false positive.

Report: what changed, how you verified it (numbers and exit codes), what you left open, findings outside the task. Open a finding with `npx github:Velklish/backslop#v0.3.0 new <slug> --parent N` and evidence. Do not push. Do not edit the repository's main tree from a worktree.

Commit subject: `PB-N: <what was done>` when the change has a task number.

## Approver path

Review the diff. Then archive and triage in one pass:

```bash
npx github:Velklish/backslop#v0.3.0 archive N
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

The suite runs on a machine that is not its own: a person's binaries and sessions are there, and a second `npm test` — a worker run by tracks puts one per worktree — may be going at the same moment. Three rules keep a run from reading or touching anything but itself. Each is enforced by a check, because each was broken in silence first.

**Every sandbox prefix is on the sweep list.** A run that is cut off — Ctrl-C, a file taken down at the file timeout, a crash — never reaches its own cleanup, and the leftovers are removed by the sweep at the start of the next run ([test/tmpdir-sweep.mjs](../../test/tmpdir-sweep.mjs)). The sweep only knows the prefixes in `SUITE_PREFIXES`, and that list is hand-built, so a sentinel in `tmpdir-sweep.test.mjs` greps `test/` for every `makeSandbox('…')` and every `mkdtemp` of a temp directory and demands the list cover them. The grep takes both spellings of the directory — `os.tmpdir()` and an imported `tmpdir()`, `path.join` and a bare `join` — because while it demanded the qualified one, a file that imported `tmpdir` was invisible to it and its prefix leaked past the sweep with the check green. Adding a sandbox with a new prefix means adding the prefix; the sentinel says so on the next run.

**A machine-wide read is scoped by something the run owns.** A second `npm test` on the same machine is the normal state — a worker run by tracks starts one per worktree — and per-file sandboxes do not separate two runs in the process table, on a tmux server, or in `/tmp`. Every such read must be qualified by a path, a pid or a mark that belongs to this run alone; a program name is not one. The register of the reads the suite makes today, and what each is scoped by, is in the header of [test/run.mjs](../../test/run.mjs), beside the serial group.

## Public surface

Do not add internal product names, private package scopes, or links into another repository's `docs/`. Examples in tests and docs use a fictional workspace. See the publicity checks in the project gates when they land.
