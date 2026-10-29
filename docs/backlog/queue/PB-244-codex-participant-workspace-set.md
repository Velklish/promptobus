# PB-244 · Give Codex workers and reviewers the workspace skill and MCP set without collisions

- **Order:** 140
- **Scope:** [reference/03-cli](../../reference/03-cli.md), [reference/05-drivers](../../reference/05-drivers.md), `lib/driver-codex.js`
- **Created:** 2026-09-23
- **Dependencies:** none
- **Cost:** major

## Context

The owner requires a Codex worker and reviewer to receive the workspace skill and MCP set with workspace entries taking precedence over personal entries of the same name, as in the Claude Code participant contract. Outside-workspace sessions keep their usual personal set.

The skill half shipped in 0.22.0 (CHANGELOG, "Canonical Codex skills override colliding personal copies per participant thread"). The holder reads `skills/list` before `thread/start`, and `canonicalSkillOverrides` (`lib/codex-session.js:944`) turns the user-scoped copies whose names collide with a canonical skill into exact-path `skills.config` session overrides, set at `lib/codex-session.js:1626-1632`; the contract is in [reference/05-drivers](../../reference/05-drivers.md) (the `~/.agents/skills` paragraph, line 1469) and [reference/03-cli](../../reference/03-cli.md) (line 187). Live evidence of the skill half is the 0.158.0 fixture `test/fixtures/codex-app-server/0.158.0/CanonicalSkills-0.158.0-2026-10-01.json`: worker and read-only reviewer turns used canonical content, with zero colliding personal descriptors and the unrelated personal descriptor kept.

What remains is the part the mechanism does not yet show: a live check on the version the driver now proves (`PROVEN_CODEX_VERSION`, `lib/driver-codex.js:52`), and the MCP side, where a server name from another source can still collide with a mechanism entry.

## Work to do

- Live verification on a Codex worker and a Codex reviewer at the proven version: record `skills/list` and the model-visible list with colliding and non-colliding personal skills. Each workspace skill appears once with canonical content, and unrelated personal skills keep their visibility.
- The MCP duplicate-name check: detect or prevent a duplicate server name from another source next to the isolated MCP set, and show what the participant actually receives (`mcpServerStatus/list`). Keep the reviewer `disabled_tools` boundary.
- Record the exact commands, exit codes, Codex version and test counts, and run the Promptobus gates after any change.

## Out of scope

- Manual Codex sessions in the workspace; the consumer's workspace owns those.
- Replacing `HOME` for the participant: it also changes git and SSH behavior, as discussed in `docs/adr/adr-007-codex-participant-isolated-home.md`.
- The skill mechanism itself, which shipped.

## Verification

- In isolated fixtures, lift one worker and one reviewer with colliding and non-colliding personal skills, and record the lists named above.
- Inspect `mcpServerStatus/list`, complete a usable MCP handshake, and verify reviewer write tools remain absent. Run the same fixture outside the workspace to prove its personal set is unchanged.
- Run Promptobus gates after implementation: `npx --no-install backslop gates`.
