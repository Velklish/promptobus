# PB-137 · Declare repository metadata and verify relative README links on the registry page

- **Scope:** `package.json`, `README.md`, `README.ru.md`, `scripts/audit-public.mjs`
- **Created:** 2026-09-06
- **Dependencies:** PB-108
- **Taken:** 2026-09-10

## Context

The registry-rendering consequence below is a hypothesis pending a rendered-page check; the missing metadata and relative links are confirmed locally.

package.json (full read) has no `repository`, `homepage` or `bugs` field. Its `files` array (lines 7-17) lists `bin, dist, lib, models, schemas, skills, templates, LICENSE, README.md, README.ru.md` — no `docs`. `npm pack --dry-run --json` confirms the actual tarball: 117 entries under 11 top-level names (`LICENSE, README.md, README.ru.md, bin, dist, lib, models, package.json, schemas, skills, templates`) — `docs` is absent. `grep -c '](docs/' README.md README.ru.md` returns 12 and 12 — 24 relative links total, into docs/adr, docs/guides, docs/reference and docs/GLOSSARY.md. `git remote -v` shows origin is the real public github.com/Velklish/promptobus, which does hold docs/adr, docs/guides, docs/reference — exactly what a `repository` field needs to point npm's registry-page README renderer at, so it rewrites relative markdown links into working GitHub blob URLs instead of leaving them relative. scripts/audit-public.mjs's link check (lines 63-72) walks tracked files from `git ls-files`, where `docs/` exists, so every link resolves there; the separate tarball surface it builds (lines 74-90) only scans FORBIDDEN strings and never re-runs the link-existence check against the extracted tarball — so this exact failure mode (a link fine in the repo, dead in what ships) is unguarded by the repo's own gate. No existing backlog entry or archive result mentions a `repository` field or this link gap (grepped docs/backlog and docs/archive).

## Work to do

- Add `"repository": "github:Velklish/promptobus"` (or the `{type, url}` object form) to package.json.
- CHANGELOG.md entry: package.json now declares `repository`, so the registry page's README links resolve to GitHub instead of being dead relative paths.

## Out of scope

- Adding `docs` to `files`, or extending scripts/audit-public.mjs's link check to run over the extracted tarball as well as over `git ls-files` — either would also close this gap, but the `repository` field is the smaller, standard fix and is what this entry picks; hardening audit-public.mjs against this class of gap is a separate, larger change.
- `homepage` and `bugs` fields — adjacent metadata gaps, but the title and consequence here are specifically the 24 dead links, which `repository` alone fixes.

## Verification

- `npm pack --dry-run` after the change still omits `docs/` — confirms the fix is the `repository` field, not a `files` change.
- On the npm registry page (or with npm's local README-render tooling) confirm a sampled `docs/` link from README.md resolves to a GitHub blob URL rather than staying a bare relative path.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including the files named in Scope and the current repository configuration. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Confirmed locally: package.json lacks repository metadata and README links target docs omitted from the tarball. The claim about npm registry rendering is unverified here and is a hypothesis; verify a rendered sample before asserting the repository field alone repairs every link.
