# Codex app-server 0.165.0 schema capture

Generated without a native session or model turn from the installed codex-cli 0.165.0 on macOS arm64. `codex --version` and `codex app-server generate-json-schema --out <temporary>` both exited 0 using the same executable; its SHA256 was equal before and after generation. `capture-provenance.json` records that generator and its complete 320-file inventory. `contract-provenance.json` records the 52 consumed schemas retained here.

Compared with 0.164.0, the consumed contract adds `modelNotFound` to nine repeated `CodexErrorInfo` definitions and a `gcp` account variant. Existing alternatives, request fields, approval methods and response requirements are unchanged. The existing finite holder/approval witnesses validate against this contract; this does not enable a new account mode or establish native admission.

Native evidence is version-scoped. The [0.164.0 capture record](../0.164.0/README.md) retains its earlier worker, reviewer, approver and hook measurements. Those measurements are not relabelled as 0.165.0. This capture establishes protocol shape only; ordinary native workflows, hook execution and lifecycle readiness require their own measurements.
