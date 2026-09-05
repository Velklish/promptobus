# PB-21 · --strategy on spawn and review, the models command, and routing metadata on the participant

- **Order:** 90
- **Scope:** [03-cli](../../reference/03-cli.md), [04-protocol](../../reference/04-protocol.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-18

## Context

The user-facing half of the plan: `spawn` and `review` accept a strategy and let the resolver pick the tuple; `models` shows what the resolver would do; the decision is kept with the participant so `status` can show it. The gate order in `lib/spawn.js` already puts harness and effort checks "before any write to disk" (lines 282–316); routing joins that gate, and a missing candidate must leave no task, worktree or participant behind.

## Work to do

- `spawn` and `review`: `--strategy <quality|balanced|speed|economy>` and `--allow-payg`; explicit `--harness`, `--model`, `--effort` are constraints handed to the resolver, never replaced; no `--strategy` → today's path exactly (the PB-12 legacy test).
- Preflight and resolve before any write; no candidate → exit with the explanation and no side effects; a limit hit between preflight and start ends the command with diagnostics, marks the cache, does not retry.
- Decision stored in participant `metadata.routing` (strategy, tuple, score, snapshot age, warnings, whether constraints applied); core does not read it, `status` does, through the driver-side accessor pattern of `src/protocol.ts` line 212.
- `promptobus status` prints strategy, tuple, snapshot age and warnings for each routed participant.
- `promptobus models` (text and `--json`, `--strategy`, `--role`, `--refresh`), `models validate` (PB-13), `models --clear-exhausted <harness>` (PB-14).
- `--dry-run` on `spawn`, `review` and `models`: live probes, printed decision, no cache write, no task state.

## Out of scope

- Changing a live participant's model; migrating running participants.
- The skill rubric — PB-19.

## Verification

- Suite: no-candidate leaves the store untouched (compare the store directory before and after); dry-run writes nothing; metadata round-trips through `status`; the golden fixtures of PB-12 turn green.
- Live: one `spawn --strategy balanced --dry-run` and one `models --json` on the owner's machine, output attached to the result.
