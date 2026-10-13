# PB-376 · Deliver a complete evidence manifest before starting a BB review

- **Scope:** [BB evidence attachments](../../reference/04-protocol.md#bb-evidence-attachments)
- **Created:** 2026-10-13
- **Dependencies:** none
- **Cost:** major

## Context

On 2026-10-13 a constrained reviewer found no source defect in a small consumer documentation change but ended with one major evidence finding: canonical raw, receipt, handover and inventories were not read because their accessible artifact IDs were absent from the context it consumed. Root had landed the full raw and sent late context supplements, yet another review phase was still needed. The precise delivery cause remains unestablished.

Evidence: [run measurements, evidence delivery observation](../../evidence/bb-orchestration-2026-10-13.json); official `bb thread log thr_kwzrcyp9fz --json --all`, exit 0, result seq 98. Root direct runner: exit 0, three of three gates, raw 510799 bytes, SHA-256 `5cbadd1b6f5871dece53764c481c7275d3b474d33053db73210b620759d26833`. The original worker had submitted a summary after piping the runner to `tail`; that pipe did not prove the runner return code.

## Work to do

- Prepare a bounded manifest containing the exact source/base SHA, producer identity, clean state, direct command exits, gate and handover artifact IDs, full-raw parts, byte counts/hashes and all five handover checks or concrete not-run reasons.
- Land every required attachment and mechanically check manifest completeness/readability before a source-and-evidence reviewer is started. Include the manifest in its initial immutable assignment; late steer or an unread mailbox must not be the only path to required evidence.
- Provide an owned command-recording path that retains complete stdout/stderr and the direct runner exit. A pipe exit or cropped raw is explicitly incomplete; attachment acceptance remains distinct from payload/schema certification.
- Preserve original producer versus relayer attribution. Reject wrong SHA, broken hash, missing part or a normal message ID used as an artifact ID before spending another review turn.
- A terminal reviewer grant stays ended. If evidence is repaired later, require a fresh bounded phase rather than reviving the old token.

## Out of scope

- Relaxing reviewer isolation, reducing the owner's reviewer model requirement or declaring incomplete evidence passing.
- Native artifact schema changes or automatic global filesystem access for reviewers.

## Verification

- A delayed-artifact fixture records zero reviewer starts until all required parts and references exist.
- On the first admitted review turn the actual bound artifact tool can read the original raw, receipts and handover by manifest IDs.
- Truncated output, a pipeline-masked nonzero runner, wrong producer/tree, missing parts, hash mismatch and message-ID substitution are refused with a precise diagnostic.
- Explicit not-run checks remain not-run; nested/custom verdict counts are compared with authoritative raw rather than certified by an unsupported flat parser.
- A retained replay of the observed delivery failure succeeds without an additional evidence-only reviewer session. Record the input, commands/exits, SHA and remaining live-provider limits.
