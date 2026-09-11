# Contributing

This repository is run entirely through [backslop](https://github.com/Velklish/backslop). There is no issue tracker beside it. The pin is `backslop.json`.

```bash
npx github:Velklish/backslop#v0.6.0 status
npx github:Velklish/backslop#v0.6.0 lint
```

The CI and package lint commands name the same tag, but `backslop upgrade` does not move them. Measured at v0.4.0 → v0.6.0: it rewrote the pin in `backslop.json`, in `docs/**` and in root `*.md`, left `package.json` and `.github/workflows/ci.yml` exactly as they were, and `lint` stayed green with both still naming the old pin. Raise the pin in those two files by hand in the same pass — `npm run pins` is what tells you when you have not. That gate (`scripts/check-pins.mjs`) is red when any tracked file names a `backslop#vX.Y.Z` disagreeing with `cli` in `backslop.json`, and it skips exactly what `upgrade` skips: `CHANGELOG.md`, `docs/adr/**`, the task archive and task cards, which cite a version as evidence of a moment rather than as a command. It runs in `gates`, by hand, and in CI ahead of the `backslop init` step. What that ordering buys is a legible failure, not a repaired tree: nothing is committed in CI, so an `AGENTS.md` that `init` rewrote at a stale pin dies with the runner and is undone by nobody. Run first, the gate names `ci.yml`, which is where the stale pin actually is, instead of pointing at a file it had just rewritten. No CI run has been made to confirm the ordering behaves that way.

**The gate says what it looked at, and its floor discounts `backslop.json`.** Green prints the counts — `43 live pin(s) in 10 file(s), 148 historical pin(s) in 134 record(s) left alone, 41 of them outside backslop.json` at the time of writing — because a pin gate that matched nothing would pass in silence, and the counts are what tells a reader the walk reached the tree rather than missing it. The config is discounted from the floor on a measurement, not on taste: the first version of the gate counted it, and pointed at a spec no file in the tree carried it reported `1 live pin(s) in 1 file(s)` and exited 0. `backslop.json` holds the very spec the gate reads its expectation from, so it matches itself whatever the walk does, and a floor it can satisfy alone is no floor. Do not simplify that back.

Why it matters is an inference, not a measurement. Measured: `init` at a given pin rewrites the `AGENTS.md` backslop block and the adapter output to that version — at v0.6.0 it changed fourteen lines of `AGENTS.md`. Inferred from that: the workflow runs `init` at the pin it names before `npm run lint:backslop`, so one left on the old pin would be expected to regenerate the old block on every push and undo the raise. No CI run has been made to confirm it.

English is the language of new strings, comments, commit messages, and checks in the runtime directories `bin/`, `lib/`, `src/`, `schemas/`, and `templates/`. `README.ru.md` may use Cyrillic; `scripts/` and `test/` are exempt from the current sweep. `npm run audit` enforces this scope on tracked runtime files and the packed tarball.

## Roles

| Role | Steps | Must not |
|---|---|---|
| Worker | 1–4: change, document, run gates | Declare the work accepted; move files in `docs/backlog/` or `docs/archive/` |
| Approver | 5–7: review, archive, triage, commit to the main line | Write the worker's code |

One agent may play both roles in order. Under orchestration they are different sessions. The worker commits on the assigned branch and stops.

Procedure text lives in `AGENTS.md` (backslop block) and in the `backslop-task` / `backslop-batch` skills that `backslop init` laid out for the selected adapters.

## Worker path

1. **Take the first queued task** from `status`, or create one:
   - `npx github:Velklish/backslop#v0.6.0 new <slug> --title "…"` → triage
   - add `--queue` to put it in the queue
   - A tiny change that does not alter a contract may skip a tracker file if one pass finishes it.
2. **Change the code.** Reverse a prior decision by deleting it. Do not strike through. Use [glossary](../GLOSSARY.md) names. If a name is missing, propose a row.
3. **Document in the same pass.** Update the matching [reference](../reference/README.md) section, this guide if the workflow changed, and `CHANGELOG.md`. An architectural choice needs `npx github:Velklish/backslop#v0.6.0 adr <slug>` and a row in [docs/README.md](../README.md).
4. **Gates on an unchanged tree.** Commands in `backslop.json` `gates` must exit 0. Also run `npm test` when you touch runtime code. The runner puts `promptobus-e2e.test.mjs`, `promptobus-mixed.test.mjs`, `promptobus-cursor-wake.test.mjs`, `promptobus-warden.test.mjs`, `model-routing-preflight.test.mjs`, and `runner.test.mjs` in the serial group because their wall-clock checks or nested pool measure machine neighbours. A test change needs a mutation probe: commit first, then break the assertion, then revert. A gate with an early cutoff needs a second probe that feeds a false positive.

Report: what changed, how you verified it (numbers and exit codes), what you left open, findings outside the task. Open a finding with `npx github:Velklish/backslop#v0.6.0 new <slug> --parent N` and evidence. Do not push. Do not edit the repository's main tree from a worktree.

Commit subject: `PB-N: <what was done>` when the change has a task number.

## Approver path

Review the diff. Then archive and triage in one pass:

```bash
npx github:Velklish/backslop#v0.6.0 archive N
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

The suite runs on a machine that is not its own: a person's binaries and sessions are there, and a second `npm test` — a worker run by tracks puts one per worktree — may be going at the same moment. Six rules keep a run from reading or touching anything but itself. Each is enforced by a check, because each was broken in silence first.

**Every sandbox and socket prefix is on the sweep list.** A run that is cut off — Ctrl-C, a file taken down at the file timeout, a crash — never reaches its own cleanup, and the leftovers are removed by the sweep at the start of the next run ([test/tmpdir-sweep.mjs](../../test/tmpdir-sweep.mjs)). Suite sandboxes use the hand-built `SUITE_PREFIXES` list in `$TMPDIR`; a two-way sentinel in `tmpdir-sweep.test.mjs` greps `test/` for every `makeSandbox('…')` and every `mkdtemp` of a temp directory, requires every literal to be covered, and rejects every list entry that covers no literal. The grep takes both spellings of the directory — `os.tmpdir()` and an imported `tmpdir()`, `path.join` and a bare `join` — because while it demanded the qualified one, a file that imported `tmpdir` was invisible to it and its prefix leaked past the sweep with the check green. Test harness sockets have short paths, so their directories live directly under shared `/tmp`; the runner sweeps their `SOCK_PREFIXES` after the same one-hour cutoff. It writes an owner marker with the run pid as a second line of defence, then probes each aged socket; a live listener or any unknown probe result holds the directory instead of deleting it. Adding a sandbox or socket with a new prefix means adding the prefix; the sentinels say so on the next run.

**Every suite file diverts home at module load.** The runner gives each file of a run its own home, so a run started with `npm test` never touches the operator's. A file run BY HAND has no runner, and that is the case the diversion is for: it applies the shared hygiene list — home, the warden switch, the session-leak names, the memory-hook lever, the `PATH` seal — from [test/home.mjs](../../test/home.mjs), and every `test/*.test.mjs` imports it **before any module that is not a Node built-in**, because one that resolved a home path at load would see the real one. A built-in captures nothing, so `node:fs` above the line is not the hazard. The verdict helper [test/check.mjs](../../test/check.mjs) imports it first in turn, so a file that names the helper is covered and needs nothing else. `home.mjs` borrows nothing itself — the sandbox is written out in it rather than taken from `sandbox.mjs`, which statically imports three package modules — and the sentinel checks that too. The apply used to live in the helper, which meant it reached only the files that wanted a verdict printer: the 22 written against `node:test` had nothing, and the two of them that actually wrote under home carried a copy of the diversion each. A sentinel in `tmpdir-sweep.test.mjs` reads the directory and refuses a suite file that imports neither, and checks that the helper really does import the apply point — otherwise "naming the helper is enough" would be a claim rather than a fact.

**A machine-wide read is scoped by something the run owns.** A second `npm test` on the same machine is the normal state — a worker run by tracks starts one per worktree — and per-file sandboxes do not separate two runs in the process table, on a tmux server, or in `/tmp`. Every such read must be qualified by a path, a pid or a mark that belongs to this run alone; a program name is not one. The register of the reads the suite makes today, and what each is scoped by, is in the header of [test/run.mjs](../../test/run.mjs), beside the serial group.

**The rule covers the scaffolding a worker builds around the suite, not only the suite's own checks — and it was learned that way.** A worker fixing the runner's take-down spent the same day enforcing this rule on `run.mjs` and then broke it in their own tooling: two wait loops of the form `until ! pgrep -f "test/run.mjs"; do sleep 10; done`, started to sleep until their `npm test` finished. `pgrep -f` matches a substring, and the consumer's suite lives at `cli/test/run.mjs`, which contains that substring — so the loops were watching a neighbouring repository's runner and outlived their own run by hours, until the operating system killed them under memory pressure. The mechanism is established; that specific match is the likely cause rather than a measured one. What supports it is which loops died and which did not: every waiter keyed on **a file the worker had created** exited on its own, and exactly the two keyed on **a fragment of a program path** survived. A throwaway one-liner is a machine-wide read like any other, and the person most likely to forget that is the one who has just finished writing the rule down.

**PATH is sealed; an unstubbed binary name resolves to nothing.** Sandboxing `HOME` and `TMPDIR` seals nothing by itself — a child process escapes through `PATH`. The runner hands every suite file a `PATH` of one directory, holding a symlink per binary in `REACHABLE_BINARIES` ([test/hygiene.mjs](../../test/hygiene.mjs)): `ast-grep`, `env`, `git`, `node`, `npm`, `pgrep`, `ps`, `sh`, `sleep`, `tar`. Nothing else is reachable, and in particular no harness binary is — `claude`, `cursor`, `cursor-agent`, `agent`, `codex` and `tmux` are absent on purpose. A file that needs one stubs it (`stubCommand` + `withStubPath` in [test/sandbox.mjs](../../test/sandbox.mjs), which prepend to the sealed value rather than replacing it); a file that forgot gets ENOENT naming the command, which is the outcome the seal exists for. Adding a name to the list means saying in the comment beside it which check needs it.

One consequence to know rather than rediscover: refusal paths that used to reach a real binary now report "not found in `PATH`" under the suite. The Cursor driver's `tmux` resolve is the visible one — it refuses instead of talking to the machine's tmux, which is the intended reading of that branch.

**A suite file exits on its own, and a single-file run is protected too.** `node test/<file>.test.mjs` is the form the mutation-probe rule prescribes, and it has no runner above it: no deadline, no child bookkeeping, and no parent to notice. When the session that started it dies, such a file is reparented to `init` and nothing will ever collect it — measured at the end of run 0911e, five orphans at `PPID 1`, all older than the sessions that could have started them, one of them holding a core for two days. The protection is a **watchdog in [test/home.mjs](../../test/home.mjs)**, the helper every suite file already imports, so no file needed an edit: an unref'd timer at 240 s. Unref'd is the mechanism — a file that has FINISHED empties its event loop and exits, and the timer never fires, so a finished file pays nothing for it, while a file still alive at the deadline has by definition a live handle, which `getActiveResourcesInfo()` then names. The number sits below the runner's own 300 s on purpose, so that under `npm test` a file reports what holds it before the runner kills it blind; the runner's deadline is the backstop.

**It is a second ceiling on a file's whole work, and it is not free.** `unref` saves the file that finished and only that one: a file still honestly working at 240 s has a live loop like any other and is taken down too, because the timer cannot tell unfinished work from a leaked handle. The message therefore names both readings rather than accusing the file. The cost differs by form — under `npm test` the ceiling moves from 300 s to 240 s, four fifths, and a file in that band was already failing as "hung", so what changes is 60 s of headroom and a diagnosis in place of a blind kill; run BY HAND there was no ceiling at all and now there is one, which is the honest price of closing the hole. The margin is narrower than the fast case suggests: the slowest file measured alone is 44.5 s, but the header of [test/run.mjs](../../test/run.mjs) records `promptobus-package.test.mjs` at 186.5 s under the pool at load average 8 — 0.78 of this ceiling. A file that legitimately needs longer is split, moved to the serial group, or given a larger `WATCHDOG_MS`. **The limit, stated rather than discovered:** a file spinning inside synchronous work never returns to its event loop and runs no timer of its own, so the watchdog does not catch that shape at all — that is the 100 %-CPU orphan of the measurement, and the same reason `SIGTERM` did not touch it. Only the runner's `SIGKILL` reaches it, and only under a run. What the suite files leave in `$TMPDIR` on a hand run is a different question and is answered by the sweep above, not here.

**A run leaves no process behind.** A file taken down at the deadline goes **with its children**: files are spawned `detached`, so each is its own process-group leader, and the take-down signals the negative pid. A plain `child.kill` reaches one process, and a suite file spawns them by the dozen — the real CLI, git, stub binaries, a nested runner — so whatever it had started was reparented to `init` and stayed; two pairs in the 0911e measurement have exactly that shape, a file and its child runner, both at `PPID 1`. Reproduced and then closed on a fixture in [test/runner.test.mjs](../../test/runner.test.mjs): a file that spawns a marked child and hangs, under a runner copy with a 2 s deadline, left the child alive before the change and leaves nothing after it. The child is found by a mark in its own command line, never by program name — the register rule above.

**Two boundaries of that take-down, named because this section's own rule is to name limits.** A child that started itself `detached` becomes its own process-group leader and is therefore NOT in the file's group: it survives. That is how the warden, the Codex holder and the suite's own long-lived stands start, and it is why the holder gate at the tail of the runner still has something to find. And once files are `detached` they no longer receive a terminal `SIGINT`/`SIGHUP` directly — the take-down now depends entirely on the runner living long enough to relay it, so a runner that is itself hard-killed leaves its files behind. What collects them then is the watchdog above, except in the one shape it admits it cannot catch.

Two further run-level gates at the tail of [test/run.mjs](../../test/run.mjs) watch what a run may LIFT, and they are mirror images. A warden may not be auto-lifted at all, so that gate judges the ACT: the lift point appends a line to the run's warden trace, and any line is a failure. A Codex holder is started on purpose — the Codex file lifts real participants — so its gate judges the MOMENT: the driver appends the pid and the session file at every holder start, and the tail refuses a holder still alive when the run ends, matching the pid against the session file in its live argv because the system reuses process numbers. A holder reaps itself once its session record goes, and the record goes with the run directory, so a red gate means a holder was still holding a live session. Neither gate kills anything; both name what is left.

**The warden gate's boundary is the environment, not the process tree.** Both halves of it are variable names — `PROMPTOBUS_WARDEN=off` is what prevents a lift, `PROMPTOBUS_WARDEN_TRACE` is what records one — so the gate reaches exactly as far as those two names travel. A child that INHERITS its environment is inside the gate for free. A child that COMPOSES one is inside it only because the code composing it names the two, and the participant's MCP server is that second kind: `mcpConfig` in [lib/driver-codex.js](../../lib/driver-codex.js) writes the bus entry's `env` rather than inheriting it. Until PB-166.2 it named neither, so a warden auto-lifted from a participant's MCP server was neither stopped by the switch nor written to the trace — measured on a live tree, the warden's parent was the MCP server and its environment carried no warden name at all. The gate was green about that process class because the suite lifts no real participant on a real binary (the Codex stand starts no MCP server of its own), not because it covered it. A silent gate is not a slightly weaker gate: it says something false about its own subject, which is why this was fixed rather than noted. The driver now forwards both names when `mcpConfig` finds them set, verbatim and only then — a real run names neither, so nothing there moves, and a live participant still gets the warden it wants. The Claude and Cursor drivers compose no `env` of their own for the bus entry, so nothing there has been shown either way — a separate finding, not a closed one.

The seal is watched, not assumed. Every command the package launches through `run` is appended to the run's resolve trace ([lib/exec.js](../../lib/exec.js), variable `PROMPTOBUS_EXEC_TRACE`), and the runner refuses a run in which any of those paths lies outside its own run directory. A name that resolved to nothing is not counted — that is the seal working. The boundary is `run` itself: a test file that calls `spawnSync` on its own does not pass through it and is not traced; those calls are `process.execPath` and stub binaries inside the file's own sandbox, and the route the gate exists for is the one through the bus boundary.

## What the stands prove, and what they cannot

A harness stand is a stub binary, not the tool. It answers the protocol the driver speaks
and does nothing else, so a check written against one proves the mechanism's half of an
exchange and never the harness's. Where the two are confused, a probe comes back green on
a broken mechanism.

The measured case, because it cost a regression: **the Codex stand records the `cwd` it is
handed on `thread/start` and never enters it.** A working directory that does not exist is
therefore invisible to every check built on that stand — only the real binary would refuse
it. So a property like "the participant's working directory is on disk before the lift"
cannot be asserted through a lifted thread at all; it has to be asserted where the
mechanism creates the directory, which for launch files is the plan (PB-161.2 moved a
reviewer's directory creation into its plan for exactly this reason, and the mutation probe
that had been silent then bit).

The general rule that follows: when a mutation probe leaves the suite green, ask what the
stand observes before concluding the code is unnecessary. Two outcomes are legitimate — the
code is genuinely dead and goes, or the property is real and must be re-expressed where the
suite can see it. "The probe was silent" is not a third one.

**A green check is not evidence until you know what it looked at, and four ways it can look past its subject were measured here.** A check whose expected value is the value the run already carries passes on code that hardcodes it — assert a sentinel the run could not have supplied, not the run's own `PROMPTOBUS_WARDEN_TRACE`. A positive half alone leaves the conditional untested: an unconditional forward writes `undefined`, which a value comparison accepts and only an `in` test rejects, so the negative control belongs in the same check. A comparison across cases can pass on the very code the change replaces — three `self-wake` states already printed three different reasons, so "the three lines differ" was green before the prognosis existed, and only the comparison with `(reason: …)` stripped out measured the conflation. And a fixture every row of which carries the new field never reaches the fallback that reads the state without it: the file looks covered, the branch is unmeasured, and it takes a row built to lack the field to find out.

## Public surface

Do not add internal product names, private package scopes, or links into another repository's `docs/`. Examples in tests and docs use a fictional workspace. `npm run audit` runs `scripts/audit-public.mjs`, which scans tracked files and the packed tarball for forbidden strings and checks tracked links for repository leaks.

**A finding that moved here from a consumer's tracker arrives carrying that tracker's names, and they must come off.** Its task identifiers and the name of its internal CLI are exactly what the audit refuses (`origin tracker ids` and `origin CLI name` in [scripts/audit-public.mjs](../../scripts/audit-public.mjs)), and this repository is public. Keep the provenance in words — whose tracker, what date, that the copy there is archived — rather than as an identifier nobody here can open anyway. The trap is quiet: `backslop lint` says nothing about it, only `audit` goes red, and a pass that skipped the heavy gate learns about it after reporting. Measured on 2026-09-12, twice in one evening from a single import: two cards carried the identifiers and the CLI name into the queue, and a CHANGELOG entry written from one of those cards carried an identifier on to the release notes.
