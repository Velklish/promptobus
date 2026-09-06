# PB-95 · The mutation probe that validates a test change is a manual multi-step dance with no script, no gate, and no record that it happened

- **Scope:** `AGENTS.md`, `docs/guides/contributing.md`, `scripts/`, `test/run.mjs`, `package.json`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

AGENTS.md:13 — "**Gates before reporting.** The commands in `gates` in `backslop.json` must be green. Verify a test change with a mutation probe: commit first, then run the probe." docs/guides/contributing.md:31 — "A test change needs a mutation probe: commit first, then break the assertion, then revert. A gate with an early cutoff needs a second probe that feeds a false positive." Both re-verified verbatim.

No script backs this today: `scripts/` holds only audit-public.mjs and six live-harness scripts (canary-runs, live-canary, live-codex, live-cursor, live-e2e, live-mixed); package.json's `scripts` block (build/prepare/pretest/test/audit/lint:backslop) has no probe entry.

test/run.mjs walks the whole `test/` directory by filename glob — its own header says "Chain runner: `npm test` = walk this directory" — and has no single-file argv mode, so a probe cannot simply shell out to `node test/run.mjs <file>`; it needs its own single-file runner call (e.g. `node --test <file>`, matching how individual `.test.mjs` files already run under `node:test`) or a small extension to test/run.mjs.

The manual procedure repeats heavily by hand: docs/archive/PB-16-cursor-availability-adapter/result.md records "Mutation probes, commit-first, 23 in all, 22 red with the module loadable each time" in one task; docs/archive/PB-39-codex-lift-waits-for-first-turn-end/result.md records "three mutation probes after commits" in another. Both are records of the procedure being performed manually, not a proposal or decision to keep it manual — no ADR or result.md argues for that.

Not tracked: grepped docs/backlog/{queue,active,deferred,triage} for "mutation probe" / "scripts/mutation" — no match.

## Work to do

- Add scripts/mutation-probe.mjs, invoked as `npm run probe -- <test-file> [--mutate <sed-expr>|--stdin-patch]`. It should: refuse when `git status --porcelain` is non-empty (enforcing "commit first" instead of relying on the agent remembering); snapshot the target file; apply the mutation; run the single test file directly (`node --test <file>`, or a per-file argv addition to test/run.mjs, whichever fits the pool/isolation design test/run.mjs's own header describes); assert a non-zero exit and print which assertion fired; restore the file from the snapshot; re-run and assert a zero exit; print a one-line verdict the agent can paste into a task or result report.
- Keep the choice of which mutation is meaningful, and the decision to run a second false-positive probe for a gate with an early cutoff (contributing.md:31), as agent judgment — script only the commit/apply/run/assert-red/restore/assert-green mechanics.
- Add a `probe` entry to package.json `scripts`.
- Update AGENTS.md:13 and docs/guides/contributing.md:31 to name the script instead of describing the manual steps.
- CHANGELOG.md entry.

## Out of scope

- Choosing which mutation is meaningful for a given test, or deciding whether a gate needs the second false-positive probe — both stay the agent's judgment.
- Extending the probe to non-test files or to gates other than `npm test`.

## Verification

- scripts/mutation-probe.mjs run on a real test file: dirty tree → refusal; a mutation that breaks an assertion → red with the assertion named; restore → green again; exit codes correct at each step.
- `npm test` stays green with the new script present; `npm run lint:backslop` clean.
- AGENTS.md:13 and contributing.md:31 name `npm run probe` instead of the four manual steps.

## Deferred

- **Deferred:** 2026-09-07
- **Reason:** Mutation probes already have a documented manual procedure; a new mutation CLI is optional tooling, not a prerequisite for the fixes.
- **Return condition:** A recurring measured failure of the manual procedure justifies a helper with a restoration and assertion-matching contract.

## Triage — 2026-09-07

- **Track:** X — Deferred structural work.
- **Priority:** P3.
- **Evidence level:** source/definition review at `1e0401a`, including the files named in Scope and the current repository configuration. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
