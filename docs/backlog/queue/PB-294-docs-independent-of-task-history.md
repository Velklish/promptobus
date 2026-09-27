# PB-294 · Make published documentation independent of tracker entries and private run artifacts

- **Order:** 440
- **Scope:** [Reference](../../reference/README.md), README files, guides, ADRs, skills and documentation navigation
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

The owner requires documentation that stands on its own and contains no task links. Current contract explanations repeatedly depend on task identifiers, archived task bodies, and transient run artifacts.

## Evidence

- At b3d4a387, a Markdown AST scan of all 69 tracked documentation files found 149 links to specific task records. Excluding backlog cards and archive/LOG.md leaves 147 such links; docs/TRACKS.md alone contains 139. These are task hyperlinks, including historical citations; the count does not assert that every surrounding paragraph depends semantically on its task body.

- A plain PB-number scan excluding backlog cards, archive/LOG.md and CHANGELOG.md found 450 identifier occurrences on 193 lines in 28 files. These are identifier counts, not 450 hyperlinks.

- Examples outside TRACKS: docs/guides/contributing.md:18 points at archive/LOG.md#pb-94; docs/reference/03-cli.md:1136 points at #pb-243; ADR-013/015/016/017 link to task history. docs/guides/hooks-and-trust.md:72-74 relies on codex-stop-live-evidence.json, absent from tracked files. ADR-023:18 defers exact harness skill locations to a card.

- docs/reference/05-drivers.md:246,421,435 and docs/reference/03-cli.md:927 refer to unidentified REPORT sections 2/4.3/4.8/4.11. No corresponding report is tracked. This is missing provenance, not proof that the old measurements were false.

- 05-drivers.md:848-849 says the symbol is unavailable in another branch, but lib/driver-claude.js:277-295 now exports the described markLimitAtStart helper.

## Work to do

- Replace task pointers in current docs with the actual contract, limitations, rationale, and durable evidence or a normal documentation section.
- Remove task-provenance labels from consumer/reference prose; retain substantive measurements with their version and date where they explain current limits.
- Move the old TRACKS planning snapshot to Git history or tracker-owned history rather than keeping a task-dependent reader guide in docs navigation.
- Keep the operational tracker, backlog cards and archive journal functional; they are the records being referenced, not consumer documentation. Review CHANGELOG task pointers separately without rewriting release facts.
- Replace unidentified REPORT references and current other-branch dependencies with available stable sources or self-contained contract/evidence boundaries; name the current markLimitAtStart symbol.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- Enumerate every retained documentation file and scan Markdown links plus plain identifiers: consumer/reference docs require no PB-number lookup, backlog/archive task link or untracked task artifact.
- A reader without Git task bodies can follow installation, operations, diagnostics and contributor procedures.
- Review the before/after diff for lost constraints and measurements; removing provenance must not remove the only explanation of an operational boundary.
