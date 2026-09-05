# PB-19 · Orchestrate skill: auto → concrete strategy rubric and the strategy envelope

- **Order:** 100
- **Scope:** [03-cli](../../reference/03-cli.md), `skills/orchestrate/SKILL.md`, `skills/solo-review/SKILL.md`
- **Created:** 2026-09-05
- **Dependencies:** PB-21

## Context

`auto` is not a CLI value: the orchestrating agent classifies the task and hands the CLI one concrete strategy. That rubric is harness-neutral, so by the owner's decision of 2026-09-05 it lives in this package's `skills/orchestrate`; consumers reference it and add their own policy (which models they forbid, which harness the reviewer stays on). Today the skill names `--model` and `--effort` only.

## Work to do

- Rubric in `skills/orchestrate/SKILL.md`: contracts, architecture, security, migrations, incidents and ambiguous tasks → `quality`; ordinary development → `balanced`; reconnaissance and small precise changes → `speed`; bulk low-risk routine → `economy`. Price of a mistake moves a task up one row, as the existing model matrix of the consumer does.
- Strategy envelope agreed with the person before the first spawn: the strategy per track, allowed harnesses, PAYG policy. A fallback inside the envelope needs no second approval; leaving it does.
- Explicit constraints from the person travel to the CLI unweakened; the skill never rewrites `--model` into a strategy.
- Two review rounds without progress → step up: the next strategy or an explicit tuple, named in the run's result.
- `skills/solo-review/SKILL.md`: the reviewer's strategy (default `quality`) and the diversity rule.
- The skill names `promptobus models` as the way to see what a strategy would pick.

## Out of scope

- Consumer-specific deny lists and defaults.
- The intake-phase skill of a consumer.

## Verification

- `backslop lint`, `npm run audit` green; the suite test that pins skill text (if any) updated.
- Read-through: a fresh session given the skill and a task description arrives at one strategy without asking which flag to use.
