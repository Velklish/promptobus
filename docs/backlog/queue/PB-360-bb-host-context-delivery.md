# PB-360 · Deliver Host rules, skills and canonical tools into BB participant environments

- **Scope:** [Host](../../reference/02-host.md), [Drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-08
- **Dependencies:** [PB-364 · Add a local BB plugin entry point with engine-backed tools and authenticated participants](PB-364-bb-plugin-engine-and-participant-binding.md), [PB-366 · Prove and define BB reviewer sandbox and tool restrictions before full runtime support](PB-366-bb-reviewer-enforcement-contract.md)
- **Cost:** —
- **Order:** 50

## Context

The Host already supplies project rules, skills, participant server configuration and reviewer tool classification. Native isolated-home and wrapper delivery do not establish equivalent behavior in BB provider sessions. Plugin bus tools can replace bus MCP transport inside BB, but they do not automatically deliver or restrict all other Host tools.

Evidence: Source snapshot `9a2a758209802e0b9632aad958f862d15e2e4c30`: `src/host.ts`, `lib/integration.js`, `lib/driver-codex.js` and Host participant configuration. BB SDK 0.6.15 `bundled-types/bb-plugin-sdk.d.ts:21818` selects the plugin's own tools/skills; it does not expose a universal external MCP injection field. Existing workspace parity work remains a separate native concern.

## Work to do

- Connect the BB entry point to the Host context collection contract; provide a generic integration tested with a fictional multi-repository workspace.
- Define delivery of project/module/base rules, skills and canonical external tools for the chosen BB providers and newly provisioned environments.
- Use source generator/plugin setup integration where generated files are required; do not hand-edit generated adapters as the delivered solution.
- Apply reviewer canonical write-tool classification through the mechanically enforced restrictions contract; keep worker and reviewer identities distinct.
- Document which setup responsibilities belong to Promptobus, the BB plugin and a consumer-owned Host integration. Keep consumer-specific provenance and configuration outside this public repository.

## Out of scope

- No internal product names, private packages, consumer tracker IDs or cross-repository documentation links.
- No claim of parity from tool/skill name counts alone, and no changes to existing native Host delivery defaults.

## Verification

- In a fictional root workspace, nested repository and BB worktree, observe the intended repo > module > base rule precedence in actual participant sessions.
- Workers receive the expected skills and canonical tools; reviewers receive the allowed reads and mechanically denied writes.
- Verify generated setup from a fresh environment and packed/installed plugin delivery, without depending on ignored files from the developer checkout.
- Native workspace/Host parity checks and public-surface audit remain passing.
