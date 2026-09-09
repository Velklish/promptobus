# PB-143 · 32 of the 59 sweep prefixes have no producer in this repository, and the completeness gate is one-directional so the dead half can never go red

- **Scope:** `test/tmpdir-sweep.mjs`, `test/tmpdir-sweep.test.mjs`, `docs/guides/contributing.md` § Suite isolation
- **Created:** 2026-09-06
- **Dependencies:** PB-144
- **Taken:** 2026-09-10

## Context

`test/tmpdir-sweep.mjs:96` declares `SUITE_PREFIXES`, a hand-built array the header comment says is "watched" for completeness by `test/tmpdir-sweep.test.mjs`. Reading the gate (`tmpdir-sweep.test.mjs:270-293`): it greps `test/*.mjs` for every `makeSandbox('…')` and `mkdtempSync(path.join((os.)tmpdir(), '…'))` literal into `declared`, then computes `uncovered = declared.filter(([, pre]) => !SUITE_PREFIXES.some((known) => pre.startsWith(known)))` and asserts `uncovered.length === 0` — this is exactly and only the produced⊆listed direction. There is no companion assertion that every `SUITE_PREFIXES` entry is a prefix of some declared literal, so a stale or renamed-away entry can never turn the gate red.

Ran the same grep the gate runs, now: `declared` has 76 literal occurrences (61 unique prefixes) across `test/*.mjs`; `SUITE_PREFIXES` has 59 entries; 32 of them cover zero declared literals:
```
promptobus-activation-, promptobus-archive-, promptobus-base-, promptobus-bgsess-,
promptobus-bootstrap-, promptobus-bushook-, promptobus-check-, promptobus-cli-flags-,
promptobus-console-, promptobus-doctor-, promptobus-env-, promptobus-exec-,
promptobus-external-, promptobus-fresh-, promptobus-homedir-, promptobus-hooks-test-,
promptobus-lint-, promptobus-manifest-, promptobus-modules-, promptobus-plugin-,
promptobus-publish-, promptobus-refs-, promptobus-review-, promptobus-root-,
promptobus-rules-, promptobus-setup-, promptobus-skills-, promptobus-smoke-,
promptobus-sync-, promptobus-tools-, promptobus-util-, promptobus-zone-
```
Cross-checking several of these against `consumer-cli/cli/test/*.mjs` (the sibling package this repository was split from): `doctor.test.mjs:19`, `fresh.test.mjs:18` and `lint.test.mjs:22` now write `consumer-cli-doctor-`, `consumer-cli-fresh-`, `consumer-cli-lint-` — and `consumer-cli/cli/test/tmpdir-sweep.mjs` carries its own `SUITE_PREFIXES` with the `consumer-cli-` spelling of these same names. This confirms the 32 dead entries in promptobus's list are leftovers from before the split, not live promptobus prefixes.

`docs/guides/contributing.md` § Suite isolation documents `SUITE_PREFIXES` maintenance as an ongoing, repeated chore: "Adding a sandbox with a new prefix means adding the prefix; the sentinel says so on the next run" — a hand-built list that can silently accumulate untraceable dead weight is a real, recurring-maintenance cost, not a one-time read. `docs/archive/PB-14.5-sweep-check-misses-imported-tmpdir` fixed the opposite gap (widened literal detection so more sandboxes get demanded) and explicitly scoped "Rewriting the sweep itself" as out of scope — so this asymmetry was left untouched by that entry's design, not resolved by it. No ADR or comment defends keeping the 32 dead entries as deliberate.

## Work to do

- Remove the 32 dead entries listed in Context from `SUITE_PREFIXES` in `test/tmpdir-sweep.mjs`.
- Add a companion assertion to the gate in `test/tmpdir-sweep.test.mjs`: every `SUITE_PREFIXES` entry must be a prefix of at least one declared literal; fail and name any entry that is not.
- Update `docs/guides/contributing.md` § Suite isolation's description of the sentinel to say it checks both directions.

## Out of scope

- Widening the literal-detection grep itself (PB-14.5 already did that) — this entry only prunes and closes the gate in the other direction.
- The `consumer-cli` copy of `tmpdir-sweep.mjs` — a separate repository with its own backlog.

## Verification

- `node --input-type=module -e "import{SUITE_PREFIXES}from'./test/tmpdir-sweep.mjs'..."` (the script used in Context) reports zero dead entries after the prune.
- Mutation probe: reintroduce one of the removed entries into `SUITE_PREFIXES` — the new gate assertion goes red, naming it.
- `npm test` stays green.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `test/tmpdir-sweep.mjs:96`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
