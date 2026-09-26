# PB-283 · spawn prints near-limit three times per participant while models prints no near-limit line

- **Scope:** [03-cli § Model routing](../../reference/03-cli.md#model-routing)
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** minor (hypothesis)

## Context

2026-09-26 12:21–12:23, workspace host 0.88.0, package 0.17.0: every `spawn … --strategy quality|balanced` line read `warnings: near-limit, near-limit, near-limit`; `promptobus status` repeats them per participant; `promptobus models` at 12:24 prints no near-limit line and warns `unknown-remaining` for claude, codex and cursor plus `balance-fallback`. Presumably the warning code is emitted from the per-harness availability entries without the line that names the harness and the strategy it would switch to (skills/orchestrate/SKILL.md § When `models` says an account is running short). Hypothesis; scope lib/model-routing/resolver.js, lib/models.js.
