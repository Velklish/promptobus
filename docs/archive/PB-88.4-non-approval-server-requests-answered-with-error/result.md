# PB-88.4 · Result

**Closed 2026-09-11.** Completed. Owner decision of 2026-09-11: the holder keeps refusing `account/chatgptAuthTokens/refresh` (it never holds a token to hand back), along with `item/tool/call` and `attestation/generate`, with the JSON-RPC error `-32601` and `unknown: true`. The list of non-approval requests is derived from `ServerRequest.json` (every method without an `APPROVE` row) rather than retyped, and the test requires exactly those three — a fourth request in a re-measured schema turns the test red instead of falling into a silent fallback. 03-cli § The Codex holder names the three requests, the holder's answer and the price: a turn with an expired token ends in an authorization error, and that is expected rather than a holder defect. Worker of run 0911d (`codex` track), squashed with PB-161.

**Verification.** `test/promptobus-driver-codex.test.mjs` (the derived list and the answer); gates as for PB-161.

**Documentation in the same pass.** `docs/reference/03-cli.md` § The Codex holder, CHANGELOG.
