# PB-37.5 · Result

**Closed 2026-09-10.** Decided, nothing to implement. The owner chose on 2026-09-10 to keep `promotion-expired` validate-only: a decision warning changes no pick, and on the shipped catalog the two Gemini rows would carry it into every routed decision until they are re-verified — the reminder is `models validate`, where PB-37.1 put it. The three pinned places — `$defs.warningCode.enum` in `schemas/model-routing/decision.schema.json`, `DECISION_WARNINGS` in `lib/model-routing/resolver.js`, the 03-cli warning table — stay as they are.

**Verification.** The "validate-only" reading of the card's Verification is already on `main` at `3ccdf27`: `docs/reference/03-cli.md:346` states that `promotion-expired` is validate-only and never reaches a decision, and `lib/model-routing/resolver.js:72-75` and the schema enum agree. No runtime change; `npx github:Velklish/backslop#v0.4.0 lint` and `npm run audit` exit 0 on the tree that archives this card.

**Documentation in the same pass.** Not required: the sentence the decision needs exists. This result records the decision.

**Acceptance.** Decision by the owner, Павел Ким, 2026-09-10; recorded by the orchestrator session that triaged the findings of the 2026-09-09/10 runs.
