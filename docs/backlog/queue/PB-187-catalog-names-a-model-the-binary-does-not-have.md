# PB-187 · The catalog and Codex inventory need a home and visibility contract

- **Order:** 200
- **Scope:** `models/catalog.json` (`codex-mini-*`), `lib/model-routing/validate.js` (`models validate`),
  [reference/03-cli](../../reference/03-cli.md) § Codex availability, [guides/model-routing](../../guides/model-routing.md)
- **Created:** 2026-09-12, release run
- **Dependencies:** none

## The measurement was misattributed

The original claim said that the catalog names `gpt-5.4-mini`, which the binary does not have. That
claim is not reproducible as written. The binary's raw `codex debug models` output is not one
machine-wide list: a comparison needs the exact executable, `CODEX_HOME`, and the `visibility`
selection rule. The first live warning offered for this card, `flag-not-in-inventory`, was also
rejected: the resolver emits it for an overlay's `allow`/`deny.flags`, while a model mismatch is
`model-not-in-inventory`.

## The source and the two homes

Measured 2026-09-12 with codex-cli 0.146.0, using the executable named by each command:

```
CODEX_HOME=/var/folders/t8/8c_15_yx4hzdw8_wt5_15bb00000gn/T/promptobus-codex-homes/beklog-0912c-t20260912-091528-worker-codex-b18dd25c0b85
/opt/homebrew/bin/codex debug models
→ exit 0; 10 rows
  visibility=list: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2, gpt-5.3-codex-spark
  visibility=hide: gpt-5.4, gpt-5.4-mini, codex-auto-review, gpt-reserve

2026-09-12T14:12:47.696Z and 2026-09-12T14:12:49.760Z, same home and command: the two lists were identical.

env -u CODEX_HOME /opt/homebrew/bin/codex debug models
→ exit 0; 7 rows
  visibility=list: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.3-codex-spark
  visibility=hide: gpt-reserve, codex-auto-review
```

The participant home is the operational source for a participant. `gpt-5.4-mini` is present in
that binary response but marked `hide`; it is therefore not in the resolver's selectable inventory.
The owner-home response is a different set and must not be substituted for the participant home.
The number of rows alone is not evidence: command, home and visibility filter are all part of the
measurement.

## Decision

The `codex-mini-medium` and `codex-mini-high` catalog tuples stay. Keeping a rated tuple while the
binary marks its row hidden preserves the catalog rating and the raw availability fact; the resolver
already excludes the tuple as `model-not-in-inventory` until a participant home exposes it. This is
not a promise that every Codex home can run the model.

`model-not-in-inventory` is not swallowed. The resolver puts it on the candidate, the text renderer
prints it beside that tuple, and `noCandidate` carries the rendered decision when no tuple survives.
The added resolver test checks the human-visible row, not only the in-memory code.

`models validate` remains offline. It has no participant task/address from which to derive the
participant home, and a home-specific hidden row would make a generic catalog gate report a false
catalog defect. Availability is checked in the preflight snapshot and the holder's model/list gate;
this card does not add a paid turn.

## What remains open

The two measured commands above are the binary's debug catalog; no paid live turn was spent to
capture a matching `model/list` payload from this participant home. The code path that consumes
`model/list` and the hidden-row exclusion are covered by the existing stand tests and the new
rendered-row assertion, but equivalence of the two binary representations remains unclaimed.

## Verification

- A model row is compared with command, home and `visibility`, never with a bare count.
- A hidden catalog tuple is retained in the decision and printed as `model-not-in-inventory`, not
  silently replaced by another model.
- The guide and reference state that catalog membership is not a promise that the participant home
  exposes the model.
