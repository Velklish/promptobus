# PB-242 · Result

**Closed 2026-09-22. Done.** `test/harness-codex.mjs` names the fixture directory off
`PROVEN_CODEX_VERSION` instead of repeating `0.146.0`, so the constant and the schemas cannot
disagree without saying so. `test/codex-fixtures.test.mjs` holds three verdicts: the directory the
constant names exists, the schema the harness compiles (`ServerRequest.json`) is in it, and the
harness has not gone back to spelling a version literal. `scripts/check-codex-schema.mjs`
(`npm run codex-schema`, added to `gates`) compares the installed `codex --version` with the
constant and prints the regeneration command on a mismatch.

**Checks.** `npm test` — exit 0, 70/70 test files, 52/52 in the last file. `npm run
codex-schema` — exit 0: `codex 0.146.0 matches the fixtures (15 schema files)`. Mutation probe:
`PROVEN_CODEX_VERSION` set to `0.147.0` → the test file exits 1 naming the missing directory and
the regeneration command, and the script exits 1 with the same; restored → both exit 0. Second
probe, the absent-binary path: `PATH` reduced to a directory holding only `node` (`codex` not
resolvable) → the script says the binary is not installed and exits 0, which is the path CI
takes. `npx github:Velklish/backslop#v0.9.0 lint` — exit 0. `npm run pins` — exit 0.

**One gate is red and it is not this task's.** `npm run audit` exits 1 on `main` as it stands:
`✖ origin CLI name: docs/backlog/triage/PB-239-sweep-says-unknown-session-when-claude-is-off-path.md`,
added by `0be6fcba`. Measured on a clean tree with the working changes stashed — same finding,
same exit code — so it is not this change. Filed as PB-239.1 with the evidence and the two ways
out; the choice between them is the owner's.

**Docs in the same pass.** `docs/guides/contributing.md` (what the new gate protects and why it is
local, not CI), `CHANGELOG.md` under `## [Unreleased]`.
