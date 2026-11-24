# PB-467 · Triage the findings from the 2026-11-24 quality audit

- **Scope:** [Reference](../../reference/README.md)
- **Created:** 2026-11-24
- **Dependencies:** none
- **Cost:** —

## Context

The 2026-11-24 quality audit covered Promptobus v0.34.1 at `fd1125ceef0950fc83347c8ae001132c3f66fc43`. The inventory verifier covered 1,125 text files and found no missing ranges. This card tracks disposition, not implementation.

## Work to do

- PQA-6105: [PB-467.1 — Sweep abandoned service test fixtures without touching live owners](PB-467.1-sweep-owned-service-fixtures.md).
- PQA-6101: [PB-467.2 — Make the mixed-run personal Codex registry verdict match its evidence](PB-467.2-mixed-personal-registry-observation.md).
- PQA-6102: [PB-467.3 — State what the Claude canary checks in the marketplace registry](../minor/PB-467.3-claude-marketplace-observation.md).
- PQA-6104: [PB-467.4 — Point the install guide to automatic release pin updates](../minor/PB-467.4-release-updates-install-examples.md).
- PQA-6103: [PB-467.5 — Investigate cleanup attribution when mixed runs share a temporary directory](../minor/PB-467.5-mixed-shared-temp-cleanup.md). Keep it a hypothesis until the controlled check.
- PQA-6100: Reuse [PB-419 — Quality audit 2026-11-05: registration and triage](../deferred/PB-419-quality-audit-20261105.md). The recovered receipt maps 35 creations and one update, excluding the container. `npx --no-install backslop show 406.6` exited 0 and returned the exact `audit-registry-home-sweep` appendix. Its source matched the receipt body SHA-256 `8a2cf500c8546636c7c345b815ac9474313bc05c7815a75bb8541264c300cc5a`. Record that evidence on the existing registration task before closing it. This does not close [PB-443 — Investigate seven fixture scheduling dependencies with controlled event ordering](../queue/PB-443-fixture-event-ordering.md) or its seven remaining hypotheses.

## Out of scope

- Implementing findings, moving the existing queue, closing PB-419, or running real providers or stress tests.

## Verification

- Each of the six audit IDs has one disposition. The former registration gap points to its existing task instead of a new card. Run `npx --no-install backslop lint`.
