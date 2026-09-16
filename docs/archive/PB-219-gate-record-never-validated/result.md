# PB-219 · Result

**Closed 2026-09-16, merged into `PB-217`.** Same reason as `PB-220`: one handover round, one path, one place to fix. The measurement of three participants' gate records against `schemas/v1/gate-record.schema.json`, the choice of where validation happens, and the gap in the schema for a mutation probe are preserved verbatim as part 3 of `PB-217`. The one item that belongs elsewhere is named there: telling the participant the schema's name in the preamble is the subject of `PB-213`, and the edit goes into that card rather than into a second place.

**Verification.** `npx github:Velklish/backslop#v0.8.0 lint` exit 0 after the merge. No code was changed by this pass.

**Documentation in the same pass.** Not required — the card never landed a change.
