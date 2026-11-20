# PB-466 · Triage the findings from the 2026-11-20 quality audit

- **Scope:** [Reference](../../reference/README.md)
- **Created:** 2026-11-20
- **Dependencies:** none
- **Cost:** —
- **Taken:** 2026-11-20

## Context

The 2026-11-20 quality audit examined 54f22155430bdd6db65b4366ae1337b1e0dff00d and identified 36 distinct findings. The table maps them to 25 work items, including two separate investigations. PQA-4010 is an alias of PQA-2002.

## Work to do

Triage the child cards. The release owner decides what evidence can qualify a Claude canary after it starts a child. Each investigation records a controlled outcome before any fixture change.

## Findings

| Work item | Audit findings | Filed in |
| --- | --- | --- |
| [PB-466.1 - Define when a Claude canary can confirm cleanup with a registered child](PB-466.1-canary-cleanup-proof.md) | PQA-5003 | triage |
| [PB-466.2 - Recover a newly created service lock after owner record publication fails](../../archive/LOG.md#pb-466.2) | PQA-2008 | triage |
| [PB-466.3 - Confirm Claude admission rollback against the selected native session ID](../../archive/LOG.md#pb-466.3) | PQA-2011 | triage |
| [PB-466.4 - Report the same SILENT start in digest and status](../../archive/LOG.md#pb-466.4) | PQA-2009 | triage |
| [PB-466.5 - Carry unknown home and registry observations through the canary exit verdict](PB-466.5-canary-hygiene-observation.md) | PQA-5004, PQA-3003 | triage |
| [PB-466.6 - Verify native observer registration, task selection and Board contracts](PB-466.6-bb-observer-contract.md) | PQA-2000, PQA-2002, PQA-2003, PQA-2004, PQA-2005 | triage |
| [PB-466.7 - Distinguish reviewer checkpoints from file attachments in participant instructions](PB-466.7-reviewer-checkpoint-and-attachment.md) | PQA-4000, PQA-2006 | triage |
| [PB-466.8 - Document the providers eligible to run a reporter](../../archive/LOG.md#pb-466.8) | PQA-4001 | triage |
| [PB-466.9 - Document the role of the tool version in managed Claude admission](../../archive/LOG.md#pb-466.9) | PQA-4009 | triage |
| [PB-466.10 - Make Stop fixtures observe deadlines and process exit deterministically](PB-466.10-stop-fixture-event-order.md) | PQA-3000, PQA-3004 | triage |
| [PB-466.11 - Verify the idle report using controlled elapsed time](PB-466.11-idle-report-duration-fixture.md) | PQA-3005 | triage |
| [PB-466.12 - Distinguish CPU consumption from elapsed time in the load probe test](PB-466.12-cpu-probe-clock-check.md) | PQA-3002 | triage |
| [PB-466.13 - Exercise the shared interrupt deadline when Codex exchanges hang](PB-466.13-holder-interrupt-budget-check.md) | PQA-3006 | minor |
| [PB-466.14 - Align solo review instructions with strategy, task and diff-base selection](../../archive/LOG.md#pb-466.14) | PQA-4002, PQA-4003, PQA-4004 | minor |
| [PB-466.15 - Align BB installation guidance and notification qualification prerequisites](../../archive/LOG.md#pb-466.15) | PQA-2007, PQA-4007 | minor |
| [PB-466.16 - Update the capture prerequisite in the Codex workspace qualification card](../../archive/LOG.md#pb-466.16) | PQA-4008 | minor |
| [PB-466.17 - Record the approved scope of review dispatch planning in the roadmap](../../archive/LOG.md#pb-466.17) | PQA-4005 | minor |
| [PB-466.18 - Distinguish pending, refused and confirmed Stop in operator summaries](../../archive/LOG.md#pb-466.18) | PQA-4006 | minor |
| [PB-466.19 - Correct obsolete comments on hooks, message formatting and status snapshots](../../archive/LOG.md#pb-466.19) | PQA-2001 | minor |
| [PB-466.20 - Remove the unreachable Codex branch from reporter reservation recovery](../../archive/LOG.md#pb-466.20) | PQA-2010 | minor |
| [PB-466.21 - Align the contributing guide with the public audit exceptions](../../archive/LOG.md#pb-466.21) | PQA-5000 | minor |
| [PB-466.22 - Describe byte restoration and current handover requirements in the published schema](../../archive/LOG.md#pb-466.22) | PQA-5001, PQA-5002 | minor |
| [PB-466.23 - Handle the uint8 annotation in the Codex schema gate](../../archive/LOG.md#pb-466.23) | PQA-5005 | minor |
| [PB-466.24 - Investigate the Cursor turn test at the injection grace deadline](PB-466.24-cursor-grace-timing-investigation.md) | PQA-2012 | minor |
| [PB-466.25 - Investigate response framing in the Unix socket smoke test](PB-466.25-unix-socket-framing-investigation.md) | PQA-3001 | minor |

## Verification

Every distinct finding has one destination, source evidence and a check for accepting the work. The audit classified 34 findings as confirmed and two as hypotheses. The original priorities were one high, 14 medium and 21 low. Individual cards retain those priorities alongside the tracker cost.
