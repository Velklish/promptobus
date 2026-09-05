# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **ADR-003 fixes the model-routing contract before any of its code.** Four strategies and their weight table, the catalog unit `role + harness + model + effort`, the overlay layers and their precedence, the four availability states with their reason codes and TTLs, the resolver rules and tie-break, and the rule that no task, worktree or participant is written before a candidate exists. The routing decision lives in participant `metadata`, so the protocol version does not move. Nine tasks build on it; the contract is fixed once instead of re-derived nine times (PB-11).
- **Model-routing contracts land before the resolver.** Four JSON schemas under `schemas/model-routing/` — catalog, overlay, availability snapshot and the `models --json` decision — with the CLI surface, the reason codes, the exclusion, adjustment and warning codes, and the error codes written once into the CLI reference. Golden fixtures pin an input pair (catalog, snapshot) and its output pair (decision JSON, `models` text), compared under the normalisation their README states, so the nine tasks that follow implement against fixed shapes instead of inventing them. A check pins that argv with none of the new flags takes today's path exactly, and the golden comparisons that need a command nobody has written yet are marked pending rather than red (PB-12).
- **The package ships a model catalog, and overlays sit above it.** `models/catalog.json` holds the first rated matrix — nineteen `role + harness + model + effort` tuples across the three harnesses, each with a source and evidence a later maintainer can check; a model the harness exposes and nobody could rate from a named source gets no row and stays a runtime `unrated` line. `loadCatalog()` merges the shipped catalog with every overlay the host names, lowest precedence first, then the caller's constraints: a weight set is replaced whole, an allow or deny list whole per selector kind, everything else field by field, and a missing overlay file is normal. `validate()` is the library behind `models validate` — layer shapes, duplicate ids, harnesses and efforts checked against the drivers' own dictionaries, weight sums, references and contradictory allow/deny as errors; stale ratings and the canonical-priority convention as warnings that never stop a run. Production reads no JSON Schema: the grammar is written out and a parity check keeps it one grammar with `schemas/model-routing/`. Every finding names the layer that wrote the key it is about, and a warning carries `code` and `message` — the two fields a decision document may hold — so nothing downstream translates. Cursor carries effort inside the model id and nothing validates one before liftoff, so each Cursor row is pinned against a captured `cursor-agent models` listing. The overlay a person copies is in [guides/model-routing.md](docs/guides/model-routing.md) (PB-13).

### Changed

- **Host contract: `PromptobusHost` gains a required `routingPaths()`.** The host names the availability cache and the ordered overlay layers; an existing host implementation must add the method, and `tsc` refuses until it does. Those files are account-scoped, not workspace-scoped, so they do not hang off `promptobusHome()` — a per-store cache would re-probe three harnesses for every checkout of the same account. An ordered list rather than a getter per layer, so a consumer can insert its own policy layer without another change to the interface. No release is cut until the routing series ends, so a consumer meets this once, at the closing tag (PB-11).

## [0.2.1] — 2026-09-05

### Changed

- **`spawn` keeps the brief as a task artifact.** The assignment file the orchestrator passes was read into the participant prompt and forgotten, so orchestrators invented a home for brief files outside the bus. After a successful lift the brief is copied into the task files folder as `brief-<worker>.md` — next to the review diffs — and the lift output names the path. Every lift stores the brief it was given: a repeat at the same address takes the next number instead of overwriting the previous assignment, and a refused spawn keeps nothing (PB-10).

## [0.2.0] — 2026-09-05

### Changed

- **Host contract: `cloneOf(abs)` replaces `reposRoot()`.** The host names the clone a directory belongs to and its namespace path; the package no longer walks a single "repos root" or requires a two-segment namespace — `need-pair` and `cwd-need-pair` are gone from `reviewLayoutError`. A host with several zones (`repos/<group>/<repo>` beside `external/<repo>`) could not be expressed before (PB-5).

## [0.1.0] — 2026-09-04

### Added

- **Public repository skeleton:** package manifest, MIT license, backslop tracker layout, and a GitHub Actions matrix for Node 20.
- **The bus itself:** TypeScript core with tasks, mailboxes, artifacts and the driver contract; a JavaScript runtime; drivers for Claude Code, Cursor and Codex; and the `promptobus` command.
- **A host contract instead of an ambient workspace:** `PromptobusHost` is passed explicitly on every call, with a standalone implementation that reads `cwd`, Git and `promptobus.json`. A consumer with no previous store declares no legacy layout, and that is a normal state rather than a failure.
- **Documentation for a first-time reader:** README in English and Russian, an architecture decision on the standalone boundary, and guides for installation, hooks and trust, and contributing.
