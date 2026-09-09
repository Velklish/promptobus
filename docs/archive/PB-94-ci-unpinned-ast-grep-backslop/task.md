# PB-94 · CI resolves ast-grep and the backslop tag at run time from mutable sources, so a green pipeline can turn red with no commit in this repository

- **Scope:** `.github/workflows/ci.yml`, `package.json`, `test/promptobus-package.test.mjs`, `scripts/audit-public.mjs`
- **Created:** 2026-09-06
- **Dependencies:** PB-70
- **Taken:** 2026-09-10

## Context

Re-verified against the current tree (v0.5.0, ci.yml unchanged since commit 92e873c on 2026-09-06):

- ci.yml:42 — `run: npm install -g @ast-grep/cli` carries no version. Git history shows it was never pinned; no comment or ADR explains this as deliberate.
- ci.yml:61 — `npx --yes github:Velklish/backslop#v0.4.0 init …` and package.json:25 — `"lint:backslop": "npx --yes github:Velklish/backslop#v0.4.0 lint"` both name a git **tag**, mutable in principle even under the same owner's repository. Commit 92e873c ("CI runs init with the current pin") shows the tag is bumped by hand per release — treated as a pin, implemented as a movable ref rather than a SHA.
- ci.yml:44-46 — the comment above the Test step: "No compile/build step yet: this package has no source tree and no TypeScript/bundler config. Implementation arrives in follow-up work. Do not add a silent no-op \"build\" that hides the missing compile." This is false today: `src/` holds 28 files (`find src -type f | wc -l` = 28), `tsconfig.json` exists with `outDir: dist`, `noEmitOnError: true`, and package.json:20-22 declares `"build": "tsc -p tsconfig.json"`, `"prepare": "npm run build"`, `"pretest": "npm run build"`. The compile already runs as a side effect — `npm ci` (ci.yml:37) triggers `prepare`, `npm test` (ci.yml:49) triggers `pretest` — so a `tsc` failure today surfaces under "Install dependencies" or the Test step, not under its own name, and the comment tells the next editor not to fix that.
- ci.yml:16 — the matrix runs `node: [20]` only, while package.json:28 declares `"node": ">=20"`, covering 20/22/24/25. No doc explains the narrower coverage, and `node -v` on this machine (the maintainer's own) is v25.2.1.
- ci.yml:54-55 — the "Pack dry-run" step (`npm pack --dry-run`) asserts nothing test/promptobus-package.test.mjs does not already assert more thoroughly: read directly at lines 325-388, that file builds a copy via `npm run build`, runs `npm pack --dry-run --json`, then a real `npm pack`, and installs the tarball into an empty directory — strictly more coverage than the bare dry-run step adds on top.

None of these five points are tracked in docs/backlog/{queue,active,deferred,triage} (grepped, no match) or explained by an ADR/result.md as deliberate.

## Work to do

- Pin @ast-grep/cli to an exact version at ci.yml:42 (`npm install -g @ast-grep/cli@<x.y.z>`).
- Pin the backslop dependency to a commit SHA rather than a tag at both ci.yml:61 and package.json:25 (`github:Velklish/backslop#<sha>`), or keep the tag and say in a comment why it is an acceptable exception.
- Replace the ci.yml:44-46 comment with the fact that the compile already runs via `prepare`/`pretest`; either leave it implicit and say so, or add an explicit `- name: Build` / `run: npm run build` step ahead of Test so a `tsc` failure is named correctly.
- Extend the matrix at ci.yml:16 to cover a second Node major already inside the declared `>=20` range (22 or 24), or narrow `engines` in package.json to the major actually tested and say why.
- Delete the "Pack dry-run" step (ci.yml:54-55) — subsumed by test/promptobus-package.test.mjs.
- CHANGELOG.md entry for the CI hardening.

## Out of scope

- Changing how the compile works or moving `build` out of `prepare`/`pretest` — this task only makes the pipeline's own claims match what already runs.
- Vendoring or forking backslop to remove the git-tag dependency outright — pinning the ref is the smaller fix for this pass.
- tmux's install step (`brew install tmux` / `apt-get install tmux`) — its CLI surface used by the suite is stable; leaving it unpinned is a defensible choice, not addressed here.

## Verification

- `grep -n 'ast-grep\|backslop#' .github/workflows/ci.yml package.json` shows an exact version and a commit SHA (or a comment recording the tag as deliberate).
- The ci.yml:44-46 comment is gone, replaced by a line matching `npm run build`'s actual presence in `prepare`/`pretest` (or a new explicit Build step).
- `cat .github/workflows/ci.yml` shows the matrix covering more than one Node major, or `engines` in package.json matches the matrix exactly.
- `npm test`, `npm run audit`, `npm run lint:backslop` stay green on the changed workflow (run locally, since CI itself cannot be exercised here).

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including the files named in Scope and the current repository configuration. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Pin ast-grep and state the backslop pin policy. A larger Node support matrix and deletion of an apparently redundant pack step require checking their distinct coverage first; do not bundle either as unconditional cleanup.
