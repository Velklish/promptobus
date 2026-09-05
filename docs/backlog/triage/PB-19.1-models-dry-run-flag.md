# PB-19.1 · 03-cli: the models synopsis omits --dry-run while its own prose names it

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-21

## Context

Found while writing the routing rubric into `skills/orchestrate/SKILL.md` (PB-19), which had to tell an agent which command reads the cache and which one probes.

The `models` synopsis in [03-cli](../../reference/03-cli.md) § Model routing → `### Commands` is:

```text
promptobus models [--strategy <quality|balanced|speed|economy>] [--role <worker|reviewer>] [--refresh] [--json]
```

There is no `--dry-run` in it. The paragraph directly beneath, describing that same command, ends: "`--refresh` ignores live cache entries and probes again; under `--dry-run` it is the only thing that makes a probe run at all." Read in place, that sentence says `models` takes `--dry-run`; read against the synopsis, it can only mean `spawn` and `review`, which is where the dedicated `--dry-run` paragraph further down puts it ("no task, worktree or participant is written").

An orchestrating agent reading the section top to bottom will try `promptobus models --dry-run`. PB-21 writes the argument parser, so the flag either exists there or the command errors on it — and the reference decides which before the code does.

## Work to do

- Decide whether `models` accepts `--dry-run` at all. It already reads the cache without probing, so the flag is either a synonym of its default or a refusal.
- Make the synopsis and the prose say the same thing: either add `[--dry-run]` to the `models` line, or move the `--refresh` × `--dry-run` sentence out of the `models` paragraph into the `--dry-run` paragraph, where the two commands that own the flag are named.

## Out of scope

- The behaviour of `--dry-run` on `spawn` and `review`, which ADR-003 fixed and this finding does not touch.
- The parser itself (PB-21).

## Verification

- The `models` synopsis and every sentence about `models` name the same flag set.
- `npx github:Velklish/backslop#v0.3.0 lint` and `npm run audit` green.
