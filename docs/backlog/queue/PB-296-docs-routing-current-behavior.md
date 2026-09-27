# PB-296 · Remove obsolete implementation-stage claims from model-routing documentation

- **Order:** 460
- **Scope:** [03-cli](../../reference/03-cli.md#model-routing), [Model routing](../../guides/model-routing.md)
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

The routing guide mixes the current contract with statements that completed implementation stages are still absent. This changes what users expect from cache clearing, model availability, declared steps and telemetry.

## Evidence

- At b3d4a387, docs/guides/model-routing.md:629-632 says late-limit data is in a file nothing reads and no flag clears. lib/model-routing/preflight.js:191-200 reads it and lib/models.js:370-385 implements --clear-exhausted; the guide itself already describes the flag at :32,955-968.

- Guide :294-300 describes Claude inventory as only the driver's alias set, but lib/driver-claude.js:75-112 merges full IDs, aliases and default, filtered by version; guide :1229-1234 gives this later contract.

- Guide :468-469,509-515 promises one JSON Lines row per routed participant; lib/model-routing/telemetry.js:534-549,563-610 records per harness generation, including closed generations and explicit unrouted --model usage. docs/GLOSSARY.md:102 already states the current rule.

- Guide :9-13 rejects/excludes every addressed role outside ROUTED_ROLES without the declared routed-step exception, already handled by lib/models.js:144-150,274-282 and lib/model-routing/validate.js:900-903.

- docs/reference/03-cli.md:473 says decision warnings have only code/message. schemas/model-routing/decision.schema.json:72-93 also permits harness/usedPercent and resolver.js:735-743 emits both on near-limit; a read-only assertion returned code,harness,message,usedPercent (exit 0). docs/guides/model-routing.md:245 repeats the same closed-only-on-code/message claim and belongs in the same correction.

- CLI reference :309 says role-unknown means any name outside worker/reviewer/approver. lib/models.js:144-151 accepts declared routed steps mapped via catalogRole; reference :203 already describes that supported case.

## Work to do

- Rewrite the four current-behavior sections to match the implemented cache, model inventory, telemetry and declared-step rules.
- Keep dated measurements and unresolved boundaries explicitly historical or current; remove old future-tense descriptions that contradict the current guide.
- Align the CLI routing reference too: required/optional warning fields and the role-unknown predicate must match schema and declared-step resolution.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- A reader obtains one consistent answer for cache read/clear, inventory union, per-generation telemetry and step catalogRole mapping.
- Cross-check current examples and predicates against the cited implementations and existing routing tests; do not change routing policy to fit old prose.
- A real near-limit decision is representable from the documentation, and a declared routed step is not described as an unknown role.
