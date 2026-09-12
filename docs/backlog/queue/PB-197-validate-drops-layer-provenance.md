# PB-197 · validate() drops the layer provenance of merged-catalog warnings, so a consumer cannot tell its own warning from the catalog's

- **Order:** 18
- **Scope:** [cli](../../reference/03-cli.md)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Filed by the consumer of this package, from a measurement on its side.

Once the catalog is merged, `validate()` raises `priority-duplicate`,
`priority-not-canonical` and `ladder-indistinguishable` through
`out.warn({ code, tupleIds, message })` — **with no `layer`**. A run with a personal overlay that
collapses two rungs of the ladder produced `ladder-indistinguishable` with an empty `errors` list
and no layer field anywhere in the result.

The consequence is on the consumer's side and it is concrete: a warning raised by the shipped
catalog and a warning raised by the reader's own overlay are indistinguishable in the result, so the
reader cannot answer "is this mine?" — which is the only question that decides whether to act on it.

Other warnings already carry their origin (`quality-floor-alias` is the precedent), so this is an
inconsistency inside one result shape rather than a missing feature.

## Work to do

- Either keep, for these three codes, the layer of the value that raised the warning and return it
  from `validate()`, or state in the protocol that provenance is undefined for them. The shape of
  the field and the merge rules are this package's call, not the consumer's.
- Whichever is chosen, say it in the protocol: an absent field that *might* have been present is
  worse than a documented "undefined".

## Out of scope

- The set of validation rules. Nothing here asks for a new check or a changed verdict.
- Routing the warnings to their addressee — that separation already exists.

## Verification

- The contract result of `validate()` for all three codes, on an overlay and on the shipped catalog.
- A regression case that distinguishes a warning carrying a layer from the explicitly-undefined
  case. Today's consumer-side case "an overlay raises a warning with no layer" must change its
  verdict once this lands — that flip is the evidence the change reached the result.
