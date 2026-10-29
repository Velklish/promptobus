# PB-417 · Verify the next Codex consumed contract before updating the proven capture

- **Scope:** [Codex driver](../../reference/05-drivers.md), [Contributing](../../guides/contributing.md)
- **Created:** 2026-10-30
- **Dependencies:** none
- **Cost:** major

## Context

The TypeScript baseline found installed Codex 0.165.0 while the preserved proven consumed contract is 0.164.0. This is a maintenance boundary, not evidence that the TypeScript changes broke the driver or that the newer binary is runtime-compatible.

Evidence: `npm run codex-schema` exited 1 twice on frozen planning commit 7e0488b706f01211a8399b85f5b386a7cc39ee31 and once on original runtime commit 4503555d9b007bf8b78f4f2bef963b15bb2c2563. The installed generator produced 52 consumed schemas with an additive modelNotFound error case and Account.gcp; finite witnesses passed, but exact contract comparison failed. An official private installation of Codex 0.164.0 matched all 52 schemas and exited 0 without changing the global binary.

## Work to do

- Select and independently verify the next supported Codex binary. Capture its consumed protocol with generator provenance and determine whether driver behavior or fixtures need changes.
- Preserve historical captures and distinguish schema witnesses from ordinary live workflow proof. Update the proven profile only with matching local gates and the required available-subscription measurements.
- Keep the language-only migration's public contracts unchanged; use its documented 0.164.0 tool context until a newer profile is accepted.

## Out of scope

- Disabling the exact schema gate, claiming runtime certification from additive JSON changes alone, or changing global tools during the language-only migration.

## Verification

- The chosen generator's consumed output matches its committed capture; current and historical witness checks pass. Record the ordinary workflow commands, binary identity and exit codes for the selected profile.
- Independent review has no critical or major findings; unavailable live measurements remain explicitly unmeasured.

## Deferred

- **Deferred:** 2026-10-30
- **Reason:** The language-only migration preserves the verified 0.164.0 profile. Updating protocol captures and certifying a newer harness is separate maintenance.
- **Return condition:** The owner selects the next supported Codex profile, or a required workflow can no longer run with the preserved profile. Retain the measured 0.165.0 schema differences as input to that verification.
