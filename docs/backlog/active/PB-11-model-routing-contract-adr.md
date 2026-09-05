# PB-11 · ADR-003: model routing — strategies, catalog, availability snapshot, resolver, host needs

- **Scope:** [02-host](../../reference/02-host.md), [03-cli](../../reference/03-cli.md), [04-protocol](../../reference/04-protocol.md)
- **Created:** 2026-09-05
- **Dependencies:** none
- **Taken:** 2026-09-05

## Context

The first consumer's owner wrote a routing plan on 2026-09-04: pick the model for a worker or reviewer by one of four strategies (`quality`, `balanced`, `speed`, `economy`), from a catalog of rated tuples `role + harness + model + effort`, intersected with what the local account can actually run right now (auth, model inventory, subscription limit), with a deterministic scoring resolver, `--strategy` on `spawn` and `review`, and a `models` command. Explicit `--harness`, `--model`, `--effort` stay constraints the resolver never replaces silently. Routing applies only before liftoff; a live participant keeps its harness and model.

The bus has since moved into this package, so everything harness-neutral in that plan lives here; the consumer keeps only its policy and skills. The plan was written against the old layout: paths under the consumer's home, a consumer-side command name, a reviewer/worker acceptance set that has since changed. This ADR is the contract before code (the same order the extract followed: host contract first, consumers repin after).

Decisions the owner already took on 2026-09-05, to be recorded rather than reopened:

- overlay and cache paths come from the host: cache and the global overlay under `promptobusHome()`, the workspace overlay path from a new host method; the standalone host answers `~/.promptobus/…`, a consumer maps to its own home;
- the `auto → concrete strategy` rubric lives in this package's `skills/orchestrate`; consumers reference it and add only their own policy;
- all three adapters (Claude, Cursor, Codex) are in v1;
- no consumer-side alias for the command; consumers reach `models` through their passthrough.

## Work to do

- `backslop adr model-routing` → `adr-003-model-routing.md`. It must fix, each with the plan's defaults unless the owner reverses them:
  - the four strategies and the weight table (quality / speed / quota cost / remaining: 65/10/10/15, 40/25/20/15, 20/60/5/15, 20/10/55/15); `auto` is a skill decision, never a CLI value;
  - the catalog unit (`role + harness + model + effort`), tuple fields (stable `id`, allowed roles, 1–5 ratings for `quality`, `speed`, `quotaCost`, nullable USD prices, billing mode `subscription | payg`, canonical priority, `assessedAt`, source, evidence), and the rule that unrated runtime models are shown but never auto-selected;
  - overlay layers and precedence `canonical catalog → global overlay → workspace overlay → CLI constraints`, and what an overlay may change (weights, penalties, bonuses, reviewer floor, allow/deny of harnesses, models, efforts, ratings, priority, PAYG policy);
  - availability states (`available`, `exhausted`, `unavailable`, `unknown`), the reason-code list (`binary_missing`, `not_authenticated`, `model_not_available`, `subscription_exhausted`, `probe_timeout`, `probe_failed`, `quota_unknown`, `stale_cache`, `manual_exhaustion`), TTLs (auth and inventory 1 h, limits 60 s, exhaustion until reset or manual clear, transient 5 min), the 15 s total probe budget, and the cache rules (0600, no prompts, tokens, emails or account ids; opaque local fingerprint if accounts must be told apart);
  - resolver rules: filter order, `unknown` penalised not blocked (neutral 50 % remaining minus 10 points), 5 points per live participant on the same harness capped at 20, reviewer quality floor 4 as a soft fallback with a warning, reviewer diversity bonus 5, tie-break `score → confirmed availability → canonical priority → tuple id`;
  - start behaviour: no task, worktree or participant is written before a candidate exists; a limit hit between preflight and start ends the command with diagnostics and marks the cache, no automatic retry inside the same command;
  - the routing decision is kept in participant `metadata` (`src/protocol.ts` line 212: core does not look inside), no protocol version bump.
- Host contract additions in the ADR and `src/host.ts`: the overlay path methods; whether a consumer ships its policy (deny lists, defaults) as a host-provided layer between global and workspace overlays or inside the workspace overlay — name the choice and why. State that `declaredTools()` and `resolveToolBin()` already cover harness declaration and binary presence.
- Decisions the owner must confirm, listed in the ADR as a short table with the default: PAYG excluded by default; reviewer floor an overridable default, not a constant; one locally authenticated account per harness; `unknown` penalised rather than blocking.
- A goal in [ROADMAP.md](../../ROADMAP.md); a row in the ADR table of [docs/README.md](../../README.md); glossary rows for `strategy`, `model catalog`, `tuple`, `availability snapshot`, `subscription limit`, `overlay` in [GLOSSARY.md](../../GLOSSARY.md).

## Out of scope

- Any code: schemas, catalog, adapters, resolver and flags are PB-12 … PB-21.
- The consumer's own decision record and skills.
- Changing a live participant's harness or model, mid-run migration, several accounts per harness, telemetry-driven ratings, automatic PAYG purchase, routing for the orchestrator itself — the plan's "not in v1" list, repeated in the ADR.

## Verification

- `npm run audit` and `backslop lint` green.
- Every host method the ADR names has a signature in `src/host.ts` with a doc comment, and `createStandaloneHost` answers it.
- Each section of the plan's contract (strategies, CLI, catalog, snapshot, resolver, start behaviour, skills integration) maps to a paragraph of the ADR or to an explicit "not in v1" line.
