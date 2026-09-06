# PB-55 · Two `formatNpx` hints in `lib/` name bus subcommands, so under a consumer host `prune` and `models calibrate` print commands the dispatcher does not have

- **Order:** 1000
- **Scope:** `lib/prune.js`, `lib/models.js`, `lib/done.js`, `src/host.ts`, `src/standalone.ts`, [03-cli](../../reference/03-cli.md), [02-host](../../reference/02-host.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-106, PB-147

## Context

`lib/prune.js:174` — `` `Nothing deleted. To delete: ${host.formatNpx(['prune', `--older-than ${days}`, '--yes'])}` `` — and `lib/models.js:774` — `` `to apply these lines: ${host.formatNpx(['models', 'calibrate', '--write'])}` `` — are, as of now, the only two `formatNpx`/`formatCommand` calls left under `lib/` (`grep -rn "formatNpx\|formatCommand" lib/`); both name bus subcommands, not consumer-owned ones.

Under the only real consumer host, `consumer-cli/cli/lib/promptobus/ati-host.js:259-260`, the two host members render differently: `formatNpx: (args) => ['npx', 'consumer-cli', ...args].join(' ')` vs `busCommand: (args) => ['consumer-cli', 'promptobus', ...args].join(' ')`. Reproduced now: `prune`'s dry-run line would render `npx consumer-cli prune --older-than 14 --yes`; running `node cli/bin/agents.js prune --older-than 14 --yes` in the consumer-cli repo answers `consumer-cli: неизвестная команда «prune»` and prints help with exit 0 — the dispatcher's `case` labels (`cli/bin/agents.js:223-364`) have no top-level `prune` or `models`; both live only behind `case 'promptobus'` (line 322, subcommand allowlist at line 335). `busCommand` on the same host renders the working `consumer-cli promptobus prune …`, and `lib/done.js:388` already prints exactly that form for the sibling cleanup hint.

The gate meant to catch this — `test/cli.test.mjs`'s "no message names a command the CLI does not have" — matches only the FIRST array element of a `formatNpx`/`formatCommand`/`busCommand` call against `lib/cli.js`'s own subcommand list (documented at `docs/reference/03-cli.md:3`). `prune` and `models` ARE real subcommands of the promptobus package itself, so the gate stays green (`node --test test/cli.test.mjs` → 4/4) while the rendered hint is unusable on the one host that wraps this package through a passthrough word.

Since PB-1.1 moved the one legitimate npx use case (the consumer-owned `clone`) to its own host member `cloneHint()` (`src/host.ts:300`, `ati-host.js:265`), `formatNpx` now has zero correct callers left in `lib/` — both remaining ones name bus subcommands.

## Work to do

- Replace both hints with `host.busCommand(...)`, matching the pattern `lib/done.js:388` already uses: `busCommand(['prune', `--older-than ${days}`, '--yes'])` in `lib/prune.js:174`, and `busCommand(['models', 'calibrate', '--write'])` in `lib/models.js:774`
- Widen the `test/cli.test.mjs` gate to also fail on any `formatNpx`/`formatCommand` call under `lib/` whose first literal element is one of `lib/cli.js`'s own subcommand labels — the mirror of the existing check
- Decide what `formatNpx` is still for now that it has no in-package caller: either drop it from `PromptobusHost` (`src/host.ts:286`, `src/standalone.ts:307`, and the host tests), or document in `docs/reference/02-host.md` that it exists only for consumer-owned commands and must never wrap a bus subcommand
- Update `docs/reference/03-cli.md:3`'s description of the gate to say it checks both the command name and the wrapper
- CHANGELOG entry

## Out of scope

- Any fix on the consumer side (`ati-host.js`) — this entry is about the package's own hint text

## Verification

- `node --test test/cli.test.mjs` — the widened gate fails on the current `formatNpx` calls before the fix, and passes after
- `promptobus prune` with nothing to delete, and `promptobus models calibrate` with nothing to write, both print a hint built with `busCommand`, verified by reading `lib/prune.js` and `lib/models.js` for the substitution
- On a consumer host stub whose `busCommand` differs from `formatNpx`, the rendered hint matches `busCommand`'s output

## Triage — 2026-09-07

- **Track:** L — Spawn, review and command guidance.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/prune.js:174`, `lib/models.js:774`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Fix the two bus-command wrappers. Retain formatNpx in the public host interface and document its consumer-command purpose; public API removal is excluded from this task.
