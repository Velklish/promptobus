# PB-34 · The proven Claude binary (2.1.251) resolves fable to claude-fable-5 while newer builds run Fable 5.1 — the top model is unreachable through the driver

- **Scope:** `lib/driver-claude.js` (`PROVEN_CLAUDE_VERSION`, `MODEL_IDS`), `models/catalog.json`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Found on 2026-09-06 while the catalog track (PB-29) verified the `fable` alias offline: the binary the driver proves, `claude` 2.1.251 at `~/.local/share/claude/versions/2.1.251`, carries the baked catalog `fable:{default:"claude-fable-5"}`, `latest_per_family.fable: "claude-fable-5"`, an empty `alias_migration`, and zero strings matching `fable-5-1` or `5.1`. Yet the owner's desktop Claude Code bundle is 2.1.260 and the model it runs names itself Claude Fable 5.1 (`claude-fable-5-1`); Cursor's inventory lists both `claude-fable-5-*` and `claude-fable-5-1-*`. So the top model exists on two other surfaces and cannot be started by `promptobus spawn --model fable` today, and the catalog (PB-29) pins `claude-fable-5` with a note about the successor.

## Work to do

- Re-prove the driver against a `claude` build that knows `claude-fable-5-1` (the desktop bundle or a newer `~/.local/share/claude` version): `PROVEN_CLAUDE_VERSION`, the alias table in the reference, `MODEL_IDS`, the live-liftoff check.
- Add the `claude-fable-5-1` rows to the catalog with the PB-29 rating rule once the driver can start them; move the `fable` alias row.
- Say in the reference how the proven version is chosen and what a lag costs (the best model of the family is not routable).

## Out of scope

- Rating Fable 5.1 before the driver can start it.

## Verification

- `claude --model claude-fable-5-1 --help` style offline checks on the newer binary; a live liftoff of a participant on `fable` reporting the 5.1 id in `claude agents --json`; `npm test` on the driver's version pin.
