# PB-244 · Give Codex workers and reviewers the workspace skill and MCP set without collisions

- **Order:** 550
- **Scope:** [reference/03-cli](../../reference/03-cli.md), [reference/05-drivers](../../reference/05-drivers.md), `lib/driver-codex.js`
- **Created:** 2026-09-23
- **Dependencies:** consumer BL-705 and BL-706 define the canonical Codex skill source and precedence

## Context

The owner requires a Codex worker and reviewer to receive the workspace skill and MCP set with workspace entries taking precedence over personal entries of the same name, as in the Claude Code participant contract. Outside-workspace sessions keep their usual personal set. `lib/driver-codex.js:372-384` currently copies `<workspace>/.codex/skills` into the participant directory. `lib/driver-codex.js:760-815` builds an isolated `CODEX_HOME` with the mechanism MCP set, but `:855` says `~/.agents/skills` remains visible because it follows `HOME`. The copy therefore does not establish precedence for colliding skills.

## Work to do

- Consume the canonical skill source defined by consumer `BL-706`, without requiring a global plugin enablement or modifying the owner's Codex configuration. Carry the same canonical skill names and content to both worker and reviewer, including their worktrees and reviewer sandbox.
- Apply the measured Codex mechanism from `BL-705` to suppress only colliding personal skill paths in the participant's isolated scope. Keep unrelated personal skills according to the harness contract. If the host cannot express this, expose an explicit blocker rather than report a clean set.
- Preserve the existing isolated MCP set and reviewer `disabled_tools` boundary. Detect or prevent duplicate server names from another source; show what the participant actually receives.
- Coordinate the source-path transition with consumer `BL-706` so the removal of `.codex/skills` at the workspace root cannot silently leave participants without skills. Update the driver reference and lift diagnostics.

## Out of scope

- Manual Codex sessions in the workspace; consumer `BL-706` owns those.
- Replacing `HOME` for the participant: it also changes git and SSH behavior, as discussed in `docs/adr/adr-007-codex-participant-isolated-home.md`.

## Verification

- In isolated fixtures, lift one worker and one reviewer with colliding and non-colliding personal skills. Record `skills/list` and the model-visible list: each workspace skill appears once with canonical content; unrelated personal skills retain their expected visibility.
- Inspect `mcpServerStatus/list`, complete a usable MCP handshake, and verify reviewer write tools remain absent. Run the same fixture outside the workspace to prove its personal set is unchanged.
- Record exact commands, exit codes, Codex version and test counts; run Promptobus gates after implementation.
