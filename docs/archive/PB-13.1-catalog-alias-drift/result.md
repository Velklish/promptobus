# PB-13.1 · Result

**Closed 2026-09-05.** Completed per the owner's decision: the Claude rows of `models/catalog.json` name `claude-opus-5` / `claude-sonnet-5`, the driver exports `MODEL_IDS` and reports them in the adapter's inventory beside its aliases and default, and a catalog check pins the rows against the driver's accepted set. The ids were verified two ways: the binary's own model table (a grep of the installed `claude` 2.1.251) and one authorised minimal turn per id (`claude -p --model <id> --max-turns 1 'reply with the single word ok'` → `ok`, 2026-09-05T15:47Z), recorded in the tuples' evidence and in the guide as the check to repeat for a new row. The alias hazard is in the guide beside the Cursor effort-suffix quirk. No schema change. Track `routing`, same worker and review round.

**Verification.** Probes: a row back to an alias → red; the driver dropping the ids from the inventory → red; the command and catalog fixtures moved with the ids. Gates re-run on the merged `main` tree by the approver.

**Documentation in the same pass.** `docs/guides/model-routing.md`, the catalog evidence, `CHANGELOG.md`.
