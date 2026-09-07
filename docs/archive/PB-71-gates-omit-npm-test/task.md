# PB-71 · `backslop.json` `gates` omits `npm test`, so a worker can report "gates green" with a broken suite that only fails later in CI on `main`

- **Order:** 10
- **Scope:** `backslop.json`, `docs/backlog/README.md`, `AGENTS.md`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

backslop.json:5-8 lists exactly two gates: `npx github:Velklish/backslop#v0.4.0 lint` and `npm run audit`. Neither runs the test suite — `npm run audit` maps to scripts/audit-public.mjs (package.json:24), which only shells out to `npm run build` and `npm pack` (audit-public.mjs:78-79); nothing in it invokes test/run.mjs.

AGENTS.md:13 ("Gates before reporting. The commands in `gates` in `backslop.json` must be green.") and the generated `.claude/skills/backslop-task/SKILL.md:27` both treat `gates` as the worker's checklist before reporting done. The only test-shaped clause in that step is "Verify a test change with a mutation probe: commit first, then run the probe" (AGENTS.md:13) — that fires only when the task itself touched a test file; it does nothing for a change that silently breaks an unrelated, untouched test.

.github/workflows/ci.yml does run `npm test`, but only on `push: branches: [main]` and `pull_request` (ci.yml:3-5) — by AGENTS.md's own flow (gates, then commit, then push) the commit is already on `main` by the time that job runs. Confirmed live on the current tree (HEAD cc1aca8): `npm test` exits 0, "48/48 test files passed", ~2:34 wall time.

`git log -p -- backslop.json` shows three edits (init, add `npm run audit`, version bumps); none discuss omitting `npm test`, so this is not a documented, deliberate choice. Not already tracked: PB-34.2 and PB-35.1 (both archived) are about `npm run audit` false-positiving on backlog-file wording, not about the missing test gate.

## Work to do

- Add `"npm test"` to the `gates` array in backslop.json, first — before `npx github:Velklish/backslop#v0.4.0 lint` and `npm run audit` — so a broken suite fails fast before the slower build+pack step runs.
- Update docs/backlog/README.md:26 ("Project gates are the `gates` field in `backslop.json`; `lint` is among them.") to name the test gate too, since the sentence enumerates what's in the array.
- No code change needed: `npm test` already exists as a script (package.json:23) and exits non-zero on a failing suite.

## Out of scope

- Making `npm run audit` itself run the suite — the `gates` array, not `audit-public.mjs`, is the right seam: it already lists commands to run in sequence.
- The mutation-probe requirement in AGENTS.md:13 — that already covers a task that edits a test on purpose; this entry is about a task that breaks one by accident.

## Verification

- `cat backslop.json` shows `npm test` in `gates`, ordered before `lint` and `npm run audit`.
- Break an unrelated assertion in any `test/*.test.mjs`: `npm test` now exits non-zero and is the first gate a worker runs, instead of surfacing only later in CI on `main`; revert and it's green again.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including the files named in Scope and the current repository configuration. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
