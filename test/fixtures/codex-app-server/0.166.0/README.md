# Codex app-server 0.166.0 schema capture

Generated without a native session or model turn from the installed codex-cli 0.166.0 on macOS arm64. `codex --version` and `codex app-server generate-json-schema --out <temporary>` both exited 0 using the same executable; its SHA256 was equal before and after generation. `capture-provenance.json` records that generator and its complete 321-file inventory. `contract-provenance.json` records the 52 consumed schemas retained here.

Compared with 0.165.0, 12 consumed schema documents change. `ReviewDelivery` removes `detached`: `review/start` accepts omitted delivery or `inline`. This is a schema incompatibility for arbitrary forwarded RPC using detached delivery. The existing finite review witness uses `inline` and remains valid; it does not certify every caller of the generic holder RPC.

The response schemas add `policyCapacityUnavailable` to nine repeated `CodexErrorInfo` definitions; optional nullable `startedAtMs` and `completedAtMs` timestamps to `ThreadItem`; optional nullable `generationId` to its `imageGeneration` variant; and optional nullable `workspaceName` to the ChatGPT account variant. The explicit `ThreadItem` object type preserves the existing 19 object alternatives. Approval methods and replies are unchanged. Existing finite holder/approval witnesses validate against this contract.

Native evidence is version-scoped. The [0.164.0 capture record](../0.164.0/README.md) retains its earlier worker, reviewer, approver and hook measurements, and the [0.165.0 capture record](../0.165.0/README.md) retains its earlier schema evidence. Neither is relabelled as 0.166.0. This capture establishes protocol shape only; ordinary native workflows, hook execution and lifecycle readiness require their own measurements.
