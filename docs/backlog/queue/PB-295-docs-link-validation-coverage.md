# PB-295 · Repair dead anchors and add complete documentation-link verification

- **Order:** 450
- **Scope:** [Reference](../../reference/README.md), [Contributing](../../guides/contributing.md)
- **Created:** 2026-09-27
- **Dependencies:** PB-290, PB-291, PB-292, PB-293, PB-294, PB-296, PB-297, PB-298, PB-299, PB-300, PB-301, PB-302, PB-295.1, PB-293.1, PB-301.1

- **Cost:** major

## Context

The existing green gates do not establish the requested documentation contract. Two repository-local anchors are broken while package and installed-skill link failures are also outside the current coverage.

## Evidence

- At b3d4a387, CHANGELOG.md:394 links to docs/guides/model-routing.md#participant-telemetry; the actual heading at model-routing.md:464 generates #participant-telemetry-the-collecting-half. CHANGELOG.md:546 links to the removed #the-approver-writes-to-the-shared-clone-the-harness-guard-and-the-key-that-lifts-it in docs/reference/05-drivers.md.

- AST scan: 69 tracked Markdown files, 880 explicit Markdown/HTML links, 855 relative links, 2 missing local anchors, no missing local files. 25 external link occurrences resolve to 12 unique URLs; HTTP GET returned 200 for all 12 on 2026-09-27.

- `backslop gates --json` at the baseline exited 0: five commands exited 0, 85/85 test files and 3960/3960 reported checks passed. npm run audit checked 426 tracked text files and 146 packed entries, yet the doc findings remain. scripts/audit-public.mjs:175-198 checks relative target existence, not heading anchors; its packed loop checks forbidden content rather than link resolution.

## Work to do

- Repair the two dead CHANGELOG anchors without changing historical release statements.
- Add a bounded documentation verification command covering all tracked Markdown, real heading anchors, reference-style and HTML links, source and delivery locations, and forbidden task dependencies in consumer docs.
- Report coverage counts and classify transient/auth/rate-limit HTTP failures as unverified instead of silently green or definitively dead; keep external-network checks separate from deterministic local CI if needed.
- Coordinate delivery-link and task-dependency expectations with their dedicated repair tasks; do not weaken current publicity rules.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- The current two bad anchors are rejected before the repair and pass after it.
- Negative controls for a missing file, renamed heading, reference-style link and broken installed-skill target must fail; no empty-inventory green result.
- The validator reports exact inspected files/links and distinguishes unresolved checks; all documented delivery contexts pass after the related repairs.
