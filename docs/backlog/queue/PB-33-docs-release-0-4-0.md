# PB-33 · Documentation, the orchestrate rubric, acceptance evidence and the release note for 0.4.0

- **Order:** 110
- **Scope:** `CHANGELOG.md`, `README.md`, [01-overview](../../reference/01-overview.md), [02-host](../../reference/02-host.md), [03-cli](../../reference/03-cli.md), `skills/orchestrate/SKILL.md`, `skills/solo-review/SKILL.md`, `docs/ROADMAP.md`
- **Created:** 2026-09-06
- **Dependencies:** PB-24…PB-32, PB-36

## Context

The subscription-balance series (ADR-004) changes the snapshot, the catalog, the resolver, the overlay merge, the host contract and the CLI surface. Each task documents its own subsystem in the same pass; this task is the pass over the whole: one release note, the rubric that tells an orchestrating agent when to use `balance`, and the acceptance evidence the tag stands on.

## Work to do

- `CHANGELOG.md`: the tasks' entries merged into **one release note** for 0.4.0 under the unreleased heading — for the user (what `models` now shows, `balance`, `models strategy`, the moved workspace overlay and the fact that `model-routing.local.json` in the repository root is no longer read, the telemetry file `promptobus done` now appends to and what it never holds) and for the host implementer (the `writable` layer, the snapshot v2 fields, the overlay merge by union and the two selectors).
- `README.md` and `README.ru.md`: every command, flag and key of the series present once, with the precedence flag → overlay default → none; the line "The four strategies are …" (141 in both) becomes five; the sample `models` output (138 in both) no longer prints `unknown-remaining: claude exposes no limit source` — the finding PB-26.1 has the evidence; the reference: the reason codes table unchanged unless a task added one; `docs/guides/model-routing.md` — the stale `<workspaceRoot>/model-routing.local.json` path in the layers table and the "Save it as …" line (PB-25's open edge).
- `skills/orchestrate/SKILL.md`: the rubric — `balance` is the strategy for a person who pays for several harnesses and wants them spent evenly; the `near-limit` line; the one-time Cursor plan question; the reviewer no longer pinned to one harness by the package. `skills/solo-review/SKILL.md` follows for the reviewer.
- `docs/ROADMAP.md`: the goal of the series marked with evidence.
- `docs/GLOSSARY.md`: the rows for window, binding window, pace, tier, writable layer — from the "Terms this decision adds" table of ADR-004; `docs/guides/model-routing.md`: the workspace overlay's new home and the fact that `<workspaceRoot>/model-routing.local.json` is no longer read.
- **Acceptance evidence, in the result**: `promptobus models --refresh` on the owner's machine for the three harnesses (tier and windows for each; no secret in the cache, mode `0600`); `models --strategy balance --role worker` and `--role reviewer` with the pace table; a staged exhaustion (fixture or `--clear-exhausted` path) moving the choice to another harness; `models strategy --set economy` followed by `spawn --dry-run` picking it up; `npm pack` contents; a live bus round in a throwaway repository with `--strategy balance`. The approver runs the live parts; the worker prepares the commands and the fixture-based parts.
- The catalog table (PB-29) handed to the owner and confirmed before the tag.

## Out of scope

- Cutting the tag: the approver does, when `queue/` and `active/` are empty.
- Consumer documentation.

## Verification

- `npm test`, `npm run audit`, `backslop lint` green on `main`; `npm pack --dry-run` lists `skills/`, `models/catalog.json` and `dist/`.
- The release note reads as one entry; no task number without a file; no consumer name in the tree (`npm run audit`).
