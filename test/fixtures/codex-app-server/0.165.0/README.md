# Codex app-server 0.165.0 schema capture

Generated without a native session or model turn from the installed codex-cli 0.165.0 on macOS arm64. `codex --version` and `codex app-server generate-json-schema --out <temporary>` both exited 0 using the same executable; its SHA256 was equal before and after generation. This directory retains only this README and the dated `capture-provenance.json`, which records the generator and its complete 320-file inventory.
The consumed schema files were not committed to this repository.
The [commit message for `adb620f8`](https://github.com/Velklish/promptobus/commit/adb620f8) summarizes runs on `7e0488b7` and `4503555d` that compared 52 consumed schemas against 0.164.0. See the [parent README](../README.md) for the current consumed contract.

The comparison recorded an added `modelNotFound` case and a `gcp` account variant.
The finite holder/approval witnesses passed, but the exact contract comparison against 0.164.0 failed. Neither outcome establishes native admission or enables a new account mode.

Native evidence is version-scoped. The [0.164.0 capture record](../0.164.0/README.md) retains its earlier worker, reviewer, approver and hook measurements. Those measurements are not relabelled as 0.165.0. This capture establishes protocol shape only; ordinary native workflows, hook execution and lifecycle readiness require their own measurements.
