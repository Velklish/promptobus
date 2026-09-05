# PB-21 · --strategy on spawn and review, the models command, and routing metadata on the participant

- **Scope:** [03-cli](../../reference/03-cli.md), [04-protocol](../../reference/04-protocol.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-18
- **Taken:** 2026-09-05

## Context

The user-facing half of the plan: `spawn` and `review` accept a strategy and let the resolver pick the tuple; `models` shows what the resolver would do; the decision is kept with the participant so `status` can show it. The gate order in `lib/spawn.js` already puts harness and effort checks "before any write to disk" (lines 282–316); routing joins that gate, and a missing candidate must leave no task, worktree or participant behind.

## Work to do

- `spawn` and `review`: `--strategy <quality|balanced|speed|economy>` and `--allow-payg`; explicit `--harness`, `--model`, `--effort` are constraints handed to the resolver, never replaced; no `--strategy` → today's path exactly (the PB-12 legacy test).
- Preflight and resolve before any write; no candidate → exit with the explanation and no side effects; a limit hit between preflight and start ends the command with diagnostics, marks the cache, does not retry.
- Decision stored in participant `metadata.routing` (strategy, tuple, score, snapshot age, warnings, whether constraints applied); core does not read it, `status` does, through the driver-side accessor pattern of `src/protocol.ts` line 212.
- `promptobus status` prints strategy, tuple, snapshot age and warnings for each routed participant.
- `promptobus models` (text and `--json`, `--strategy`, `--role`, `--refresh`), `models validate` (PB-13), `models --clear-exhausted <harness>` (PB-14).
- `--help`: the `models` line and `--strategy` / `--allow-payg` on `spawn` and `review`, turning PB-12's pending help check green; routing error codes registered in `ERROR_CODES` (`src/v1/errors.ts`) so the reference-vs-enum drift check covers them.
- `--dry-run` on `spawn`, `review` and `models`: reads the cache only, prints the decision with the snapshot age and a `stale_cache` warning when due, writes neither cache nor task state; live probes only with `--refresh`, and `--refresh --dry-run` still writes nothing (owner's decision 2026-09-05).

## Notes from PB-18 (2026-09-05)

- `resolve({ role, strategy, constraints, policy, snapshot, liveParticipants, now })` and `render(decision)` in `lib/model-routing/{resolver,render}.js` are pure; `policy` is the whole answer of `loadCatalog()`, `constraints` is `{ harness, model, effort, allowPayg }`, `liveParticipants` is `[{ harness, model, role }]`. `resolve` throws `GateError` with codes `role-unknown` / `strategy-unknown` — register them in `ERROR_CODES` with the routing codes. `chosen: null` is the `candidates-empty` case and the document is still complete for the diagnostics printed before refusing.
- `--allow-payg` is read from both `policy.policy.payg.allow` and `constraints.allowPayg`; tuples of a harness the snapshot does not carry are filtered, not listed as excluded (the snapshot's harness set is the declaration).
- The command validates explicit constraints BEFORE calling `resolve`: a `--harness` the workspace never declared (not in `host.declaredTools()`) raises `harness-unknown`, a value outside the closed lists `constraint-unknown` — `resolve` itself silently drops tuples of a harness absent from the snapshot and would report an empty candidate list instead.
- Warning order in a decision: merge-copied first, then snapshot-derived per harness in name order, then `reviewer-floor-not-met`; `live-participant` is one adjustment row carrying the capped total.

## Notes from PB-14 (2026-09-05)

- A `stale_cache` entry carries no `models` and no `windows`: `models --dry-run` on a cold or expired cache lists no runtime models for that harness and reports the old `checkedAt` as the age. If the text output is expected to still list stale inventory, the change is in `lib/model-routing/cache.js` (`snapshotEntry`), not in the command.
- `preflight` takes `adapterFor` and `harnesses` as parameters: pass `adapterOf` from `lib/drivers.js` and `host.declaredTools()`; `rated` is the predicate from the merged catalog. A verdict's `source` is taken as the adapter gave it — the command may want to guard against an adapter labelling its own answer `cache`.

## Out of scope

- Changing a live participant's model; migrating running participants.
- The skill rubric — PB-19.

## Verification

- Suite: no-candidate leaves the store untouched (compare the store directory before and after); dry-run writes nothing; metadata round-trips through `status`; the golden fixtures of PB-12 turn green.
- Live: one `spawn --strategy balanced --dry-run --refresh` and one `models --json` on the owner's machine, output attached to the result.
