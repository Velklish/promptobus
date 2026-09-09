# PB-137 · Result

**Closed 2026-09-09.** Completed with the card's smaller fix. `package.json` now declares `"repository": "github:Velklish/promptobus"`, the standard metadata the npm registry uses to turn README's repository-relative links (the `docs/` links that the tarball does not carry) into GitHub blob URLs instead of leaving them as dead relative paths. `files` is unchanged — `npm pack --dry-run` still lists 119 entries and no `docs/` — and `scripts/audit-public.mjs` was not widened to the extracted tarball (the card's Out of scope). `homepage` and `bugs` stay as they were.

**What is verified and what is not.** The metadata half is verified: the field is present and the package test's gates pass. The registry-rendering consequence — that a sampled `docs/` link on the registry page resolves to a GitHub blob URL — was NOT rendered in this run: no registry publish happened and no local README-render tooling was used; it remains the card's stated hypothesis until the next publish is looked at.

**Verification.** Worker commit `8a480e7` (worktree of `worker:verify`, on `main` `9741f41`). Reproducer: an explicit metadata assertion exit 1 before the edit ("package.json must declare repository github:Velklish/promptobus"), exit 0 after; `npm pack --dry-run --json` exit 0 with 119 entries and no `docs/`. Gates on `8a480e7`: `npm test` exit 0, 54/54 test files; `npx github:Velklish/backslop#v0.4.0 lint` exit 0, 0 errors; `npm run audit` exit 0, 663 tracked files, 119 tarball entries. Mutation probe: the field removed → the assertion exit 1; restored → exit 0. Review: the orchestrator read the diff (one field, one CHANGELOG bullet) — no isolated reviewer session was spent on it. Approver: squash of the worker branch onto `main`; CHANGELOG union; `backslop lint` and `npm run audit` on the integrated tree exit 0.

**Documentation in the same pass.** CHANGELOG entry under Fixed.

**Acceptance.** Implementation: Codex `gpt-5.6-luna` max (`worker:verify`, strategy `balance`, bus task `pb-run-0909b-t20260909-184312`). Review: orchestrator.
