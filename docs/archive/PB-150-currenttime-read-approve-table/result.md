# PB-150 · Result

**Closed 2026-09-09 — done through PB-88.** The `currentTime/read` row of the holder's `APPROVE` table, whose `ok` and `no` values were computed once at import and therefore answered every request with the holder's boot time on the `no` path, is gone: PB-88's follow-up made `decideApproval` recognise `currentTime/read` before the table and `onServerRequest` answer each request with a fresh `new Date().toISOString()`, with a comment beside the table saying why the method cannot be a static row (items 1 and 3 of this card). Item 2 — a fresh value on the deny path — is unreachable by construction: after PB-88 `looksLikeConfigRead` matches by method only and can never match `currentTime/read`, and `decideApproval` allows the method before any denial, so no deny reply for it exists to fix.

**Verification.** In PB-88's final commit `17baae7`: the holder fixture sends two `currentTime/read` requests and asserts two different fresh timestamps with no deny or warden line; removing the branches → 104/105 with that check red and two "unknown deny" lines; restored → 105/105. See PB-88's result for the gates.

**Acceptance.** Closed by the orchestrator at PB-88's integration; no separate worker pass.
