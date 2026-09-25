# PB-187 · The catalog and Codex inventory need a home and visibility contract

- **Scope:** `models/catalog.json` (`codex-mini-*`), `lib/model-routing/validate.js` (`models validate`),
  [reference/03-cli](../../reference/03-cli.md) § Codex availability, [guides/model-routing](../../guides/model-routing.md)
- **Created:** 2026-09-12, release run
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 220
- **Taken:** 2026-09-25

## The measurement was misattributed

The original claim said that the catalog names `gpt-5.4-mini`, which the binary does not have. That
claim is not reproducible as written. The binary's raw `codex debug models` output is not one
machine-wide list: a comparison needs the exact executable, `CODEX_HOME`, and the `visibility`
selection rule. The first live warning offered for this card, `flag-not-in-inventory`, was also
rejected: the resolver emits it for an overlay's `allow`/`deny.flags`, while a model mismatch is
`model-not-in-inventory`.

## The source and the two homes

Measured 2026-09-12 with codex-cli 0.146.0. Three observations from the same
`env -u CODEX_HOME /opt/homebrew/bin/codex debug models` series show that the
binary output is unstable between calls:

- `2026-09-12T19:01:00.142+03:00` — 8 rows were recorded: list
  `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.2`; hide
  `gpt-5.4`, `gpt-5.4-mini`, `codex-auto-review`. This is the observation time
  recorded for the first result; the command timestamp was not captured.
- `2026-09-12T19:02:26+03:00` — 7 rows: list
  `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.3-codex-spark`; hide
  `gpt-reserve`, `codex-auto-review`.
- `2026-09-12T19:02:51+03:00` — 8 rows: list
  `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.2`; hide
  `gpt-5.4`, `gpt-5.4-mini`, `codex-auto-review`.

Each recorded command exited 0. The response is therefore not a stable inventory:
the three observations have two different sets. If a `--refresh` stores the shorter
answer, tuples for models missing from it become `model-not-in-inventory` until the
next refresh.

The resolver does not consume this binary output. It consumes the Codex entry in
`~/.agents/model-routing/cache.json`. The measured cache snapshot has
`takenAt=2026-09-12T16:02:19.941Z` and five rows:
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`,
`gpt-5.3-codex-spark`. None has a `hidden` field, and `gpt-5.4-mini` is absent.
It is therefore excluded as `model-not-in-inventory` because it is absent from the
snapshot, not because it is hidden. The hidden set observed above belongs only to
the separate binary output; the live hidden-row retention path has no hidden row in
this cache to verify. `model/list` and `debug models` differ in content, not only
format.

## Decision

The `codex-mini-medium` and `codex-mini-high` catalog tuples stay. The
resolver consumes the cache, not `debug models`; in the measured cache,
`gpt-5.4-mini` is absent, so its current exclusion is `model-not-in-inventory`
for absence from the snapshot. The existing stand fixture covers hidden-row
retention for a `model/list` response, but the live cache above contains no
hidden row with which to verify that path.

`model-not-in-inventory` is not swallowed. The resolver puts it on the candidate, the text renderer
prints it beside that tuple, and `noCandidate` carries the rendered decision when no tuple survives.
The added resolver test checks the human-visible row, not only the in-memory code.

`models validate` remains offline. It has no participant task/address from which to derive the
participant home, and a home-specific hidden row would make a generic catalog gate report a false
catalog defect. Availability is checked in the preflight snapshot and the holder's model/list gate;
this card does not add a live turn.

## What remains open

The remaining live question is whether `model/list` differs under the owner and
participant `CODEX_HOME` values. The closing measurement must put both payloads
side by side, report whether either has `hidden` rows and whether their model
sets differ, then attempt a holder lift for a model hidden in the participant
home but visible in the owner home and record the holder's response. That
question remains open; the cache/debug discrepancy and the instability of
`debug models` are measured findings, not substitutes for it.

## Verification

- A model row is compared with command, home and `visibility`, never with a bare count.
- The stand fixture asserts hidden-row retention for `model/list`; the measured live cache
  contains no hidden row, so that retention is not live-verified.
- The guide and reference state that catalog membership is not a promise that the participant home
  exposes the model.

## Re-triage, 2026-09-23

Checked on `39316bc2` from the repository root. **Cost `major`**: whether the participant's `CODEX_HOME` exposes a catalog model is unanswered, so a routed pick can name a model the participant home does not list. The guide records the inventory as home-specific (`docs/guides/model-routing.md:103`).

- Every measurement here is stamped 0.146.0, and the installed binary is `codex-cli 0.156.1` (`codex --version` → exit 0). The open measurement is to be taken on the binary that lifts.
- The tuples stay and are still excluded: `grep -n "codex-mini-medium\|codex-mini-high\|gpt-5.4-mini" models/catalog.json` → exit 0, `:1873`, `:1875`, `:1915`, `:1917`. The owner's routing cache, read on 2026-09-23 outside this repository, lists seven Codex rows (three `gpt-6-*`, three `gpt-5.6-*`, `gpt-5.5`), none hidden and no `gpt-5.4-mini`.
- The resolver side holds: `model-not-in-inventory` at `lib/model-routing/resolver.js:266`, `flag-not-in-inventory` only for overlay flags (`:596-606`), the human-visible row asserted at `test/model-routing-resolver.test.mjs:1441-1448`, and hidden-row retention in the stand fixture (`test/model-routing-adapter-codex.test.mjs:204-211`). `lib/model-routing/validate.js` imports no probe.
- **Stale Verification line:** "the guide and reference state that catalog membership is not a promise". Only the guide says it (`docs/guides/model-routing.md:103`); `grep -n -i "catalog membership" docs/reference/03-cli.md docs/reference/05-drivers.md` → exit 1.
- **Inconsistency to settle with the measurement:** the guide says the same executable with `CODEX_HOME` unset returned "a different seven-row set" (`docs/guides/model-routing.md:103`), while this card and `docs/reference/03-cli.md:583-593` record 8/7/8 rows for the unset home.
- **Overlap with PB-246:** its item "re-check the inventory of the participant's own `CODEX_HOME`" is this card's open measurement. Whoever runs first records the owner and participant payloads side by side on 0.156.1 and answers the other card.

## Re-triage, 2026-09-25

PB-196 measured on codex-cli 0.156.1 with no turn: `model/list` answers byte-identically in the owner's home and a participant home — 7 rows, none hidden, default `gpt-6-astra`; with `includeHidden: true` it answers 9, `gpt-reserve` and `codex-auto-review` hidden. The adapter sends `model/list {}`, so hidden rows never reach it. `debug models` answers the same 9 rows in both homes, twice each, byte-identical. `gpt-5.4-mini` is in neither listing.
