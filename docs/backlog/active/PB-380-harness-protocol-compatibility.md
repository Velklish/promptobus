# PB-380 · Harness admission must check protocol capabilities instead of versions

- **Scope:** [04. Protocol](../../reference/04-protocol.md)
- **Created:** 2026-10-18
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 40
- **Taken:** 2026-10-18

## Context

The installed Codex reports 0.163.0, while `scripts/check-codex-schema.mjs` accepts only the recorded 0.158.0 and 0.162.1 labels. The command exits 1 because the version differs, without establishing that the consumed protocol is incompatible. Bumping the proven version alone would recreate the refusal on the next release.

The owner also approved removing numeric admission for the four supported native harness families and the separate workspace consumer layer. Lower floors already admit newer versions; they are not the cause of the schema mismatch. Their removal is an explicit policy change: executable discovery, actual protocol/capability/security checks, honest requested/effective settings and actual CLI refusals remain authoritative.

This is one cross-repository delivery with two independently accepted slices. The Promptobus slice lands first and becomes the base for downstream acceptance. The workspace consumer slice follows in its own isolated worktree and acceptance phase; it is not part of an unrelated source-copy task.

## Work to do

- Capture the installed Codex 0.163.0 complete app-server schemas through the no-model schema-generation command. Preserve exact command, binary/version identity, capture metadata, complete files and hashes; retain historical captures unchanged.
- Replace version-only schema refusal with checks of the protocol actually consumed by the holder, mocks and API contracts, plus capture provenance/integrity. A new, old or unparseable label alone must not reject an otherwise usable contract; incompatible/malformed/missing required protocol or security features must still fail with a specific actionable reason. Do not merely bump `PROVEN_CODEX_VERSION` or stop validating schemas.
- Remove the explicitly approved numeric native admission checks in `lib/driver-codex.js`, `lib/driver-cursor.js`, both the effort and routed-inventory checks in `lib/driver-claude.js`, and `lib/model-routing/adapter-opencode.js`. Keep missing executable, actual command/auth/holder errors, timeout, unavailable model and requested/effective effort reporting. Preserve the static-inventory boundary and actual CLI rejection; do not claim unmeasured support.
- Deliver the separate workspace consumer correction in `cli/lib/tools.js` numerical tool minima/admission, its use by the consumer's Promptobus host adapter, `cli/lib/doctor.js` executable retention/security-query path and obsolete effort refusal help in `cli/bin/agents.js`. Retain version telemetry and discovery; an unknown label must not discard a found binary or skip the Codex hook trust check. Preserve compatible public API behavior where needed.
- Update current documentation and meaningful fixtures/regressions for both slices, retaining exact requested/effective and actual refusal evidence. Review and accept each repository on its own exact current-main SHA; the card closes only after both slices are accepted.

## Out of scope

- Paid/live/native model turns, SDK/Stop/provider probes and runtime transport or permission changes. No model execution is required for schema capture or fixture verification.
- Any mutation, rebuild, reinstall or switch of the frozen active runtime/plugin.
- tmux, Git and Node prerequisites; BB engine compatibility; consumer CLI/base contracts; module/ref/SHA checks; dependency pins/identity; schemaVersion, MCP and Connect protocol versions; provenance labels, binary/auth/permissions/identity and current-grant checks.
- Rewriting history or introducing a generic capability framework. Existing effective reviewer restrictions stay intact.

## Verification

- The original installed-version-only refusal is reproduced and the repaired gate accepts a synthetic newer or unparseable harness label with the same valid consumed contract. A later numeric release alone stays informational.
- Complete 0.163.0 schema/provenance files are present and verified; no historical capture is replaced. Fixtures cover holder/mock/API compatibility, malformed/missing schemas and required feature/security refusals. Mutations prove these checks reject incompatible inputs.
- Fixture-only native tests cover each of the four harness families: numeric/format labels do not decide availability, while missing executable, timeout, auth/command failure, unavailable model and real feature refusal retain their measured outcomes. Claude effort reporting remains honest when the CLI rejects a request.
- Consumer fixtures cover old/new/unparseable version labels with usable binaries, executable discovery, actual missing capability and retained Codex hook trust/security queries. No paid or live harness scenario is inferred from mocked fixtures.
- Each affected regression has an independent meaningful mutation/probe after commit. Required repository gates and fresh independent review precede exact-SHA integration acceptance. The Promptobus gate is corrected before other Promptobus candidates use it; downstream bases are refreshed without resetting other work or waiving gates.
- Both repository outcomes, original command exits/counts/hashes, acceptance SHAs and all notRun limitations are recorded. No card completion is claimed for only the first slice.
