# PB-70 · Version is declared in four places (package.json, package-lock.json, docs/reference/01-overview.md, CHANGELOG.md) and only one comparison is gated — the CHANGELOG heading and the git tag are exactly the two that have already drifted

- **Scope:** [reference/01](../../reference/01-overview.md), `test/promptobus-package.test.mjs`, `CHANGELOG.md`, `.github/workflows/ci.yml`
- **Created:** 2026-09-06
- **Dependencies:** PB-108
- **Taken:** 2026-09-10

## Context

test/promptobus-package.test.mjs:360-367 is the only version-drift gate in the suite: it reads `package.json`'s `version` and compares it to the hand-written line in docs/reference/01-overview.md (`overview.match(/Version in \`package\.json\` is \`([^\`]+)\`/)`). PB-20.2 added exactly that comparison and, on purpose, put "the release procedure itself and who bumps the version" out of scope (docs/archive/PB-20.2-overview-version-line-has-no-gate/task.md:23).

Today (v0.5.0, HEAD cc1aca8) the four places agree: package.json:3, package-lock.json:3/9, and 01-overview.md:3 are all `0.5.0`, and CHANGELOG.md:8-10 correctly shows an empty `## [Unreleased]` above `## [0.5.0] — 2026-09-06`. But two of the six tags cut so far already drifted on the two comparisons nothing gates, read straight from the tags just now: `git show v0.1.0:CHANGELOG.md` heads with `## [0.1.0] — Unreleased` — the changelog of the v0.1.0 tag itself never says it shipped — and `git show v0.2.0:docs/reference/01-overview.md` said "Version in package.json is 0.1.0" while `git show v0.2.0:package.json` was already `0.2.0`.

.github/workflows/ci.yml:3-5 triggers only on `push: branches: [main]` and `pull_request`; there is no `push: tags:` trigger, so cutting a tag runs no CI job and no gate at all. There is no `scripts/release.mjs` in the tree — the four places are bumped by hand every release, the same hand-edit-plus-defer/return dance visible in commits 293847d and 6aca778 clearing docs/backlog/active and docs/backlog/queue before a tag.

## Work to do

- Beside the existing check in test/promptobus-package.test.mjs (next to :360-367), add: (a) the first `## [X.Y.Z]` heading in CHANGELOG.md equals `pkg.version` and is followed by a date, not `Unreleased`; (b) when `git describe --exact-match --tags HEAD` succeeds, the tag equals `v${pkg.version}`. Same bounded pattern PB-20.2 already used, extended to the two sites that have actually drifted.
- Add `push: tags: ['v*']` to .github/workflows/ci.yml so a tag push runs the suite at all, not only pushes to `main`.
- Update docs/reference/01-overview.md's note on the version-line gate (line 5, "the suite compares it to package.json") to also name the CHANGELOG/tag checks once they exist, so the reference stays an accurate description of what's gated.
- Separately, larger and less certain — do only if the owner wants it: a `scripts/release.mjs` (`npm run release -- <patch|minor|major>`) that refuses when docs/backlog/active/ or docs/backlog/queue/ is non-empty, promotes `## [Unreleased]` to the dated heading, reopens an empty `## [Unreleased]`, bumps package.json and package-lock.json, runs the gates, and prints (not runs) the `git tag -a` command — keeping the patch/minor/major choice and the readiness judgment with the person.

## Out of scope

- Backfilling the two already-drifted tags (v0.1.0, v0.2.0) — they are shipped and immutable; the gate is for the next release, not a rewrite of history.
- Who decides patch vs. minor vs. major, and whether a release is ready — a `scripts/release.mjs`, if built, only automates the mechanical steps PB-20's tag rule already assigns to a person.

## Verification

- `npm test` with CHANGELOG.md's first heading rewritten to `## [9.9.9] — Unreleased`: the new check is red and names `pkg.version` against the bad heading; revert and it's green.
- On a commit tagged with a version that does not match `package.json` (a throwaway tag, removed after): the tag-vs-version check is red; on a matching tag it is green or skipped when untagged.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `test/promptobus-package.test.mjs:360`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Scope is version and tag parity checks. The optional release CLI is not part of this task and may only be considered on a later explicit request. Do not make an empty backlog a release requirement.
