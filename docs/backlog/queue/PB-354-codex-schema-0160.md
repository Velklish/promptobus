# PB-354 · Installed Codex 0.160.0 has no captured protocol baseline

- **Order:** 30
- **Scope:** `lib/driver-codex.js`, `test/fixtures/codex-app-server/`, [Contributing — protocol fixtures](../../guides/contributing.md), [Drivers — Codex](../../reference/05-drivers.md#codex--codex-harness-driver--the-third-production-bus-driver)
- **Created:** 2026-10-06
- **Dependencies:** none
- **Cost:** major

## Context

The mandatory local schema gate rejects the current installed binary because the newest captured protocol baseline is 0.159.2. Source-confirmed at `20d792b8f1d72970529f5eb9b1629e263af7ca7f`: `lib/driver-codex.js:47` names `PROVEN_CODEX_VERSION = '0.159.2'`; `scripts/check-codex-schema.mjs:37-51` accepts only the minimum or proven captured versions and prints the native schema regeneration command for an unmatched version. On 2026-10-06, `codex --version` exited 0 with `codex-cli 0.160.0`; `npm run codex-schema` exited 1 with the full assertion that 0.160.0 is installed but fixtures were taken from 0.159.2. The same named gate blocks a candidate after its other four configured commands passed (121/121 test files). Exact commands, exits and full output are retained in private run evidence. No external/flake classification follows from this version mismatch.

The older version-specific upgrade task targets 0.157.1 and includes separate live measurements. It remains unchanged and open; this task does not reinterpret historical evidence or silently replace those requirements. The contributing guide already prescribes binary schema capture and constant/fixture agreement for this gate.

## Work to do

- Capture the currently installed 0.160.0 binary version and generate complete app-server JSON schemas into a new versioned fixture directory using `codex app-server generate-json-schema --out <fixture-directory>`; no model turn or binary installation is needed.
- Compare the new schemas against the previous complete capture and validate every holder request and relevant response/approval contract used by the existing harness tests. Preserve minimum-version and historical evidence with its own version labels.
- Update `PROVEN_CODEX_VERSION` and current-baseline references to the captured version only after the holder schema checks pass. Any incompatible request, permission, identity or response semantics need an explicit design decision before runtime changes.
- Document the generated-schema measurement and its limits, including which native behavior was not remeasured; retain historical live evidence without relabelling it.

## Out of scope

- Installing, downgrading or replacing the owner's binary; bypassing the gate or changing its acceptance policy.
- Historical live-measurement requirements of the older upgrade task, unsupported model/harness changes, and other drivers' cleanup or environment fixes.

## Verification

- `codex --version` and the schema-generation command name 0.160.0 with exit 0; the fixture directory contains full client/server captures and a source-backed inventory/provenance record.
- Holder request shapes and response/approval expectations validate against the captured schemas; minimum-version and historical checks remain green with retained guarantees and names.
- `npm run codex-schema` exits 0 for the actual installed binary without an environment, version or gate bypass. A committed mutation restoring the old baseline or breaking the new fixture binding makes the targeted check red, then restored green.
- Documentation distinguishes schema validation from native model-turn or hook measurements. All five configured repository gates and final tracker lint pass, with separate worker, isolated reviewer and approver acceptance.
