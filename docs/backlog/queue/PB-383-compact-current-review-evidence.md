# PB-383 · Orchestration review handoffs must use compact current evidence and a compatible collector from the first check

- **Order:** 300
- **Scope:** [Participant coordination](../../reference/01-overview.md), canonical orchestration skill and BB evidence handoffs
- **Created:** 2026-10-19
- **Dependencies:** none
- **Cost:** major

## Context

A source-review closure carried 1086 references: 1078 raw artifacts, four receipts and four other records. Public dispatch took 7m55s before review because the current validator reads references sequentially. A three-file README minor had 84s of gates followed by about 40 minutes to local acceptance, with hundreds of receipt/support files. Late custom-collector and manifest-schema differences added packaging-only phases after successful checks. These observed intervals overlap other work; they do not establish an aggregate time-loss or token-savings percentage.

The problem is requiring unrelated historical read/status payloads again for each current closure, and discovering receipt incompatibility after execution. Historical failures and complete originals must remain available. Required current source and execution proof cannot be reduced to a summary or invented receipt.

Evidence: saved redacted dispatch/command timing readback and original schema-mismatch outcomes. Private locations remain in the run-owned supporting sidecar, not this portable card. Next step: future triage review; filing does not authorize implementation or add this card to an ongoing execution batch.

Related [PB-381](PB-381-orchestration-obtainable-admission-evidence.md) owns obtainable admission proof and permission planning; [PB-382](../../archive/LOG.md#pb-382) owns resource-scoped scheduling. [PB-373.4](../../archive/LOG.md#pb-373.4) owns bounded report delivery rather than evidence selection. Preserve the [BB evidence contract](../../reference/04-protocol.md#bb-evidence-attachments).

## Work to do

Recovery audit, 2026-10-20, priority: before repeated review closure. The original 1,086-reference dispatch receipt was checked against its raw streams: 475.143 seconds, exit 0. Current `bb-plugin-promptobus/review-evidence.ts` still reads declared artifact references sequentially. Reuse the existing recorder/uploader and move current-evidence selection into code; do not create another run-specific collector. The audit also confirmed an unfinished-receipt self-read that failed packaging and was repaired without rerunning the suite. A collector must finalize command output before admitting its receipt. These samples do not justify a universal artifact cap or an estimated savings percentage.

- Give workers the existing supported canonical collector, exact receipt/manifest schema and minimal valid example before their first relevant mechanical check. Generate and validate evidence mechanically from originals; never synthesize direct receipts or repeat an unchanged full suite merely to reformat proof.
- Require complete current source/diff, actual required current command receipts/raw streams and exact source binding in an initial handoff. Keep complete immutable historical originals in a supporting index, available on demand. A same-reviewer findings closure carries its exact changed scope/current evidence and relevant prior findings; unrelated historical read/status streams are not mandatory again by default.
- Preserve original producer/relayer attribution, source/base/token scope, hashes/bytes, required raw references, denied/error history and honest notRun/notMeasured. Compactness must not hide a real failure, omit relevant proof, weaken role/validator/security checks, claim PASS from packaging, or skip independent review and current-main acceptance.
- Keep dispatch proportionate to current review. Use a large retained historical archive with a small current closure to prove unrelated historical payloads are not all obligatorily reread before dispatch. Measure deterministic local call counts, bytes and reads rather than prescribing a brittle universal elapsed-time target or artifact cap. Fetch relevant historical proof explicitly when needed.
- Update canonical `skills/orchestrate/SKILL.md` and actual BB role/launch/evidence guidance together, with current-required versus historical-support examples. Update consumer copies only where actual duplicated policy exists. Any admission optimization preserves validation freshness/source/hash boundaries and reports measured before/after; no universal caching framework is prescribed.

## Out of scope

- Implementation in the current execution batch, adding another current approved card, or changing its frozen runtime/plugin.
- Weakening tests, review, exact-SHA acceptance, permissions, quota, provenance or source/hash validation; changing held external publication decisions.
- OS inventory/reset, renewed SDK/Stop lifecycle work, paid/native/model probes, arbitrary hard caps or a generic process framework.

## Verification

- Exercise a valid small change with a large immutable history and small current closure; observe which refs/bytes are actually read. All required current evidence is validated while unrelated history remains retrievable without unconditional replay.
- Exercise changed-source invalidation, missing required current raw, hash mismatch, a relevant old finding, and a historical failed command retained without pretending it passed. Invalid or missing relevant proof fails; a historical archive is not silently discarded.
- Independent readback/behavioral regression verifies decisions and evidence availability, not only new wording. Use deterministic local fixtures, without new live/paid/native/SDK/Stop/model probes.
- Run normal repository checks appropriate to the separately authorized future implementation. Filing alone uses lightweight tracker/publicity/readback checks, not a full suite.
