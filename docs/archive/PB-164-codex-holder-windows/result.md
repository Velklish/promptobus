# PB-164 · Result

**Closed 2026-09-16 — by boundary, not by implementation.** Same owner decision as PB-163: Windows is outside the participant contract. The Codex holder — `codex app-server --stdio`, its thread registry, wake socket, signals and the isolated home — is measured on macOS only, and the questions this card asked (process lifetime, signals, socket and pipe paths on Windows) cannot be answered by reading code; with no Windows stand on the mechanism side and the platform declared out of scope, there is nothing left to measure. The return condition of the card named this outcome explicitly ("an explicit decision that Windows is out of scope, recorded as a boundary"). The boundary is written into README § Requirements and [03-cli](../../reference/03-cli.md) § Spawn and § The Codex holder.

**Verification.** Documentation-only closure: `npx github:Velklish/backslop#v0.8.0 gates` on the closing tree — four gates, exit codes in the acceptance report of the 2026-09-16 queue run. No mutation probe: no test changed.

**Documentation in the same pass.** `README.md` § Requirements, `docs/reference/03-cli.md` § Spawn and § The Codex holder, `CHANGELOG.md` (Unreleased → Changed) — shared with PB-163.
