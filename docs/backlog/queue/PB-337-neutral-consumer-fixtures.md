# PB-337 · Remove organization-specific content from fixtures, documents and tracker records

- **Order:** 30
- **Scope:** [Contributing](../../guides/contributing.md)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major

## Context

At `6f4e9a3`, organization-specific provenance remains in project-owned source and records. Evidence: `CHANGELOG.md:1313`; `test/promptobus-spawn.test.mjs:896`; `test/promptobus-review.test.mjs:600-601`; `test/promptobus-driver-codex.test.mjs:918,927-928`; and the real namespace/service defaults in `test/scenario.mjs:331`, repeated in review, approver and MCP fixtures. `test/promptobus-adapter.test.mjs:227-306` labels generic routing with the originating organization's name.

Current records also carry private provenance: PB-323:10, PB-324:10, PB-326:12, PB-313:30 and PB-229.1:53,61 in their respective backlog files; `docs/archive/LOG.md:129` preserves old leak examples. `scripts/audit-public.mjs:35,109-115` limits parts of its brand check to runtime paths. Cite these locations without copying prohibited identifiers into new cards.

Baseline verification on the same commit: `npm_config_cache=/tmp/project-boundary-npm-cache npm run audit` exited 1 with four findings in PB-323, PB-324 and PB-326. Two consecutive isolated runs of `npm_config_cache=/tmp/project-boundary-npm-cache node scripts/audit-public.mjs` each exited 1 with the same four findings. The original worktree was clean. PB-326 is being reframed separately; the other two records still need neutral provenance.

## Work to do

- Replace real organization fixtures with neutral synthetic equivalents and remove private names/policy descriptions from current project-owned prose and records.
- Preserve organization integration provenance and reproductions with the consumer that owns them; keep public evidence reproducible through neutral API scenarios.
- Extend the content boundary check to authored tests, docs, changelog and records without blanket directory exemptions.

## Out of scope

- Changing generic role-routing behavior solely because an old test label names its origin.
- Deleting anti-leak detector coverage through a blind search-and-replace.
- Rejecting unrelated backlog work or losing historical evidence.

## Verification

- Representative present fixture, changelog and record leaks fail the boundary check before cleanup and pass after it.
- Synthetic fixtures preserve the same behavioral assertions.
- Existing affected cards retain their actual work and evidence with neutral provenance; private evidence has an identified consumer-owned destination.
- Record exact commands, exits, counts and commit; run applicable gates.
