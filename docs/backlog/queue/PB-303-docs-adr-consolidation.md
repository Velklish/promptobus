# PB-303 · Consolidate chained ADRs into their current decisions

- **Order:** 530
- **Scope:** [Documentation index](../../README.md), [Reference](../../reference/README.md)
- **Created:** 2026-09-27
- **Dependencies:** PB-298, PB-286.1

- **Cost:** major

## Context

The ADR set records several decisions as chains of successive records. To learn the current decision on model routing, the approver, session identity, cleanup, or Codex isolation, a reader has to walk two to four ADRs and reconcile them. The owner decided to consolidate the set before release v0.20.0. Each chain keeps one ADR that states the current decision; the replaced records leave the tree, and their text stays in Git history.

## Evidence

- At d3a6050a, `docs/adr/` holds 24 ADRs. Only ADR-015 carries `Status: Superseded` (by ADR-024); the other 23 are `Accepted`.
- Chains of one decision at d3a6050a:
  - model routing: ADR-003 (252 lines) → ADR-004 (322) → ADR-005 (227), 801 lines together;
  - the approver: ADR-013 → ADR-015 → ADR-024;
  - session identity and address: ADR-010, ADR-011 (its CLI door was withdrawn), ADR-014, ADR-019;
  - cleanup after an accepted piece: ADR-016 → ADR-017;
  - Codex participant isolation: ADR-007, ADR-008.
- `docs/adr/adr-021-task-tree-and-governance-routes.md:33` refuses a Cursor or Codex teamlead "with the reason of ADR-015". ADR-015 is the one superseded record, so no current ADR states that reason.
- `docs/README.md:46` states the rule that produced the chains: "An accepted decision is not edited; it is superseded", and the replaced ADR keeps a "superseded by" note.
- `git grep` at d3a6050a, excluding `docs/backlog` and `docs/archive`, finds references to the chained ADRs in `docs/reference/03-cli.md` (27 lines), `CHANGELOG.md` (17), `docs/README.md` (14), `docs/GLOSSARY.md` (9), `docs/guides/model-routing.md` (8), `docs/reference/02-host.md` (6), `docs/reference/05-drivers.md` (5), `test/fixtures/comment-links-baseline.json` (4), code comments in `lib/`, and the ADRs themselves.

## Work to do

- For each chain, keep the successor — the highest number in the chain: ADR-005, ADR-024, ADR-019, ADR-017, ADR-008. Rewrite it as the single current decision:
  - context;
  - the decision as it stands in the code today;
  - the rationale that still holds;
  - consequences;
  - the measurements that explain a current limit, with their version and date.
  Retitle it so the title covers the whole decision.
- Delete the other ADRs of each chain. No stubs, no "superseded" notes, no strikethrough; their text stays in Git history.
- Move the reason a Cursor or Codex teamlead is refused into the ADR that governs it now, so ADR-021 no longer depends on a deleted record.
- Keep ADR-001, 002, 006, 009, 012, 018, 020, 021, 022 and 023. Change them only where a link or the moved refusal reason requires it.
- Replace the rule at `docs/README.md:46` with the rule the consolidated set follows: the ADR directory holds current decisions only. A new decision on a question already decided rewrites that question's ADR, keeping its number and the rationale that still holds, and a record that no longer governs anything is deleted.
- Repoint every link and mention of a deleted ADR to the surviving ADR:
  - the ADR index in `docs/README.md`;
  - reference, guides, GLOSSARY, README files and skills;
  - code comments and test fixtures (`comment-links-baseline.json`);
  - tests that read ADR files, including the verdicts that PB-298 added for ADR-007/008/011/013/016/019. Migrate those verdicts to the surviving text without weakening them.
- Released CHANGELOG sections keep their statements. A link from a released entry to a deleted ADR is repointed to the surviving ADR; name any exception in the result.
- Add a regression check that is red at d3a6050a and green after the change:
  - no ADR in `docs/adr/` carries a Superseded status;
  - the refusal reason cited by ADR-021 resolves to a present ADR;
  - the ADR index in `docs/README.md` lists exactly the ADR files present.

## Out of scope

- Changing any decision. The consolidation restates the current decisions; a discrepancy found between an ADR and the code is filed as a finding, not resolved here.
- Removing task references from ADRs beyond the consolidated text. That is PB-294.
- Runtime changes, publication, and closing unrelated backlog entries.

## Verification

- `docs/adr/` holds only ADRs with an `Accepted` status, and the consolidated survivors state the decisions of their deleted predecessors that still hold. The before/after review lists every constraint and measurement of a deleted ADR and where it went, or why it no longer governs.
- `npm run audit`, `backslop lint` (links, ADR index) and the regression check pass; the check fails on the base text.
- `git grep` for the deleted ADR file names returns nothing outside `docs/archive/`, `docs/backlog/` and released CHANGELOG exceptions named in the result.
