# PB-202 · Codex rollouts carry token usage on disk; attached sessions report none

- **Order:** 2
- **Scope:** `lib/model-routing/telemetry.js` (`throughputObservationOf`, sidecar reader), `lib/driver-codex.js`, `lib/driver-claude.js`, [PB-57.1](../deferred/PB-57.1-harness-throughput-producers-absent.md), `docs/reference/03-cli.md` § Participant telemetry
- **Created:** 2026-09-12, from a measurement of 268 participant sessions
- **Dependencies:** PB-57.1

## Context

[PB-57.1](../deferred/PB-57.1-harness-throughput-producers-absent.md) states that no harness reports a usable throughput observation, and about one of them it says: Codex's `turn/completed` exposes only id, status and error, and "the session paths carry no usage fields". **That premise is disproved for the rollout on disk**, and the card was deferred on it.

Measured 2026-09-12 over 35 Codex sessions (26 worker, 9 reviewer) that took part in bus runs:

| harness | where the spend is | records | Σ output tokens |
|---|---|---|---|
| Codex | `event_msg.token_count.info` in the rollout jsonl | 11 933 | 4 556 184 |
| Claude | `assistant.message.usage` in the session jsonl | 52 748 | 51 341 563 |
| Cursor | nothing in its local session store | 0 | — |

The Codex record is not a fragment: `last_token_usage` and `total_token_usage` each carry `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`, next to `model_context_window` and `rate_limits`. A neighbouring `task_complete` carries `duration_ms`, `started_at`, `completed_at`, and `time_to_first_token_ms` — the last one filled in 171 of 3309 records.

> Source: 2026-09-12, parse of `~/.codex/sessions/**/rollout-*.jsonl` and of Claude session transcripts; scripts `codex_parse.py`, `sec12.py` in the session scratchpad. Cursor read from its per-chat store, 44 sessions, no usage field found.

Two things follow, and they point in opposite directions.

**The observation is reachable for two harnesses of three.** Model-active generation time is still absent everywhere — no harness has a field for it. Derived from the gap between the end of one turn and the first item of the next: Codex p50 37.1 tok/s (n = 11 555), Claude p50 66.5 tok/s (n = 32 396). That interval excludes tool execution but includes client overhead, so it is an upper bound, not a measurement, and it must be labelled as one wherever it is used.

**Spend of an attached session is not observable this way at all.** Claude writes `cost-state` (with `modelUsage` and `totalCostUSD`) in 198 of 247 worker sessions and 191 of 242 reviewer sessions — about 80 %, all of them lifted by the mechanism. In **0 of 36** orchestrator sessions, which a human starts, is it present. The role that spends the most per run is the one with no record of what it spent.

## Work to do

- Correct the premise in PB-57.1: name the rollout as the Codex producer, keep its Cursor half, and say what is still missing for Claude and Codex alike — model-active time.
- Decide whether the rollout is a legitimate source for the throughput sidecar: it is a file the participant's own process writes, outside the bus, and reading it couples the driver to a harness layout. If the answer is no, say so in the card and close the throughput question for Codex as refused, not as open.
- State the attached-session limit in the reference rather than leaving it implicit, so that a run summary (PB-205) does not promise a number it cannot have.

## Out of scope

- Calibration itself — the scale and its bands are [ADR-005](../../adr/adr-005-ten-point-scale-absolute-bands-calibrate.md), and `calibrate` groups by `(harness, model, effort)` without the role.
- Making Cursor produce usage: nothing was found in its store, and inventing a substitute is exactly what PB-57 forbade.
- Measuring model-active time properly: no harness has the field; a separate card if it is ever wanted.

## Checks

- The corrected statement in PB-57.1 cites a fixture, not prose: a rollout record with the six usage fields, quoted with its field names.
- For every claim about a harness, the card names the file that carries it and the count of records behind the number.
- The attached-session gap is stated as a number (0 of 36) with the command that produced it, not as "usually absent".
- If the rollout is accepted as a source, a live run shows a non-null `throughput` for a Codex participant in `telemetry.jsonl`; if refused, the reference says refused and why.
