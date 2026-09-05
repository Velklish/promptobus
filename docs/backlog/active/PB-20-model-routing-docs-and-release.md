# PB-20 · Model routing docs, glossary, CHANGELOG, and the release tag

- **Scope:** [README](../../reference/README.md), [02-host](../../reference/02-host.md), [03-cli](../../reference/03-cli.md), [04-protocol](../../reference/04-protocol.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-13, PB-15, PB-16, PB-17, PB-19, PB-21
- **Taken:** 2026-09-05

## Context

Closing task of the routing series: the documentation set, the manual acceptance the plan requires before a release, and the tag consumers repin to. The plan asks the docs to keep six things apart: a maintainer's rating of a model, runtime availability to the account, the remaining subscription limit, money cost, an explicit constraint of the person, and the two decisions (strategy by the agent, tuple by the CLI).

## Work to do

- Reference: host methods in [02-host](../../reference/02-host.md); `models`, `--strategy`, `--allow-payg`, `--dry-run`, `--refresh`, `--clear-exhausted` in [03-cli](../../reference/03-cli.md); `metadata.routing` in [04-protocol](../../reference/04-protocol.md). Guides: overlay files and where they live for standalone. README: a `models` section. GLOSSARY: the PB-11 terms with evidence lines. ROADMAP: evidence for the goal.
- `docs/reference/01-overview.md` line 3 hard-codes the package version in prose and drifts on every release with no gate — bump it with the version.
- `docs/reference/03-cli.md` § Model routing: drop the "Not implemented yet" opener (the preflight track filed it as a finding) and add a maintainer note at the top of the section that `test/model-routing.test.mjs` slices it by `###` headings between `### Reason codes` and `### Files` — new headings go after `### Files`.
- `docs/reference/03-cli.md` reason-code table: the `manual_exhaustion` row says "a person marked the harness exhausted" while `markExhausted` writes it for a machine-observed limit with no reset (the merged finding PB-15.2) — align the prose with the code and the Availability subsection.
- `skills/` is tracked but not in `package.json` `files`, so a consumer installing the package gets no `skills/orchestrate/SKILL.md` to reference (the skill track's observation, 2026-09-05). Decide and do one: add `skills` to `files`, or state in the README how a consumer references the rubric (a pinned tag URL); the ADR's § Skills integration assumes one of the two.
- `docs/guides/install.md` (the cli track's observation, 2026-09-05): it still says the version banner prints `promptobus 0.1.0` (the package is past that) and that `promptobus help` does not yet list `install` — help lists `install` and `uninstall` now; fix both, and re-read the guide against the live `--help`.
- `HostFile` in `src/standalone.ts` does not declare the `generate` field that PB-8 documents in two guides and that `spawn` reads from a repository's `promptobus.json` (the cli track, 2026-09-05): add the optional field with its doc comment so the interface that reads that file for everything else names it too — a documentation-only type change, no behaviour.
- CHANGELOG entry; `package.json` version; tag (next minor). **Owner's rule (2026-09-05): the tag is cut only when the whole series is done and `queue/` and `active/` are empty** — no intermediate release for the host contract or any single task; consumers repin once, after this tag.
- Manual acceptance, recorded in the result with commands and output: `models --refresh` on Claude, Cursor (after the owner's `agent login`) and Codex; cache content free of secrets and mode 0600; an exhausted harness excluded (real or staged); one full bus round with an agent-chosen strategy, a worker and a reviewer.

## Out of scope

- Consumer docs and the consumer's repin.

## Verification

- `npm test`, `npm run audit`, `backslop lint` green on the tagged commit; `npm pack` tarball carries `models/catalog.json` and `schemas/model-routing/`.
