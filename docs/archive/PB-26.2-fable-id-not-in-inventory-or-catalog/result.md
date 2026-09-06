# PB-26.2 · Result

**Closed 2026-09-06.** Completed by PB-29 landing on `main` (de6d981): `claude-fable-5` is in `MODEL_IDS` and rated, the guard check "the scope table is the driver's" lost its `PENDING` exception in `175d1f0`, and the 03-cli paragraph says the three ids are ones the catalog rates. Nothing of its own remained.

**Verification.** The guard check is strict (every scope id in `MODEL_IDS`); `npm test` 47/47 on `main`.

**Documentation in the same pass.** Not required beyond the paragraph PB-29 and the follow-up already changed.
