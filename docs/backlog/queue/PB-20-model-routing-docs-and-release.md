# PB-20 · Model routing docs, glossary, CHANGELOG, and the release tag

- **Order:** 110
- **Scope:** [README](../../reference/README.md), [02-host](../../reference/02-host.md), [03-cli](../../reference/03-cli.md), [04-protocol](../../reference/04-protocol.md)
- **Created:** 2026-09-05
- **Dependencies:** PB-13, PB-15, PB-16, PB-17, PB-19, PB-21

## Context

Closing task of the routing series: the documentation set, the manual acceptance the plan requires before a release, and the tag consumers repin to. The plan asks the docs to keep six things apart: a maintainer's rating of a model, runtime availability to the account, the remaining subscription limit, money cost, an explicit constraint of the person, and the two decisions (strategy by the agent, tuple by the CLI).

## Work to do

- Reference: host methods in [02-host](../../reference/02-host.md); `models`, `--strategy`, `--allow-payg`, `--dry-run`, `--refresh`, `--clear-exhausted` in [03-cli](../../reference/03-cli.md); `metadata.routing` in [04-protocol](../../reference/04-protocol.md). Guides: overlay files and where they live for standalone. README: a `models` section. GLOSSARY: the PB-11 terms with evidence lines. ROADMAP: evidence for the goal.
- CHANGELOG entry; `package.json` version; tag (next minor).
- Manual acceptance, recorded in the result with commands and output: `models --refresh` on Claude, Cursor (after the owner's `agent login`) and Codex; cache content free of secrets and mode 0600; an exhausted harness excluded (real or staged); one full bus round with an agent-chosen strategy, a worker and a reviewer.

## Out of scope

- Consumer docs and the consumer's repin.

## Verification

- `npm test`, `npm run audit`, `backslop lint` green on the tagged commit; `npm pack` tarball carries `models/catalog.json` and `schemas/model-routing/`.
