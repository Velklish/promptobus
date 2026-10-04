# PB-335 · Keep the development tracker out of consumer documentation and release metadata

- **Scope:** [Contributing](../../guides/contributing.md)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 70
- **Taken:** 2026-10-04

## Context

At `6f4e9a3`, consumer delivery includes the repository's development tracker. `README.md:259,264,269,273` publishes its lint/init/status commands and config location; `README.ru.md:238-249` repeats them. `skills/orchestrate/SKILL.md:284` sends installed-skill readers to this repository's contribution tracker. `package.json:30,62-65` carries the tracker script and dependency into release metadata. `npm pack --dry-run --json --ignore-scripts --cache /tmp/promptobus-audit-npm-cache` exited 0: 151 files, including both READMEs, that skill and package.json. This is filesystem membership, not a freshly built release.

The tracker remains valid for developing Promptobus. Its installed files and internal contributor instructions must remain usable.

## Work to do

- Keep tracker commands and explanations in internal contributor documentation; make consumer READMEs and installed skills describe Promptobus usage.
- Remove the shipped orchestration skill's contribution-tracker link.
- Prepare release metadata without development-only tracker fields while preserving the source checkout's dependency and commands.
- Add an artifact-level boundary check; package.json.files alone cannot exclude npm's mandatory manifest.

## Out of scope

- Uninstalling the development tracker or deleting its installed hooks, docs and skills.
- Runtime hook admission, covered by PB-334.
- General removal of contributor documentation from the source repository.

## Verification

- Build and inspect the real tarball and installed skills: no tracker-specific explanation, config or command reaches consumers.
- The regression check fails on the current README, skill and manifest examples.
- A development checkout still installs dependencies and runs its local tracker workflow.
- Record exact commands, exit codes, counts and commit; run applicable gates.
