# PB-65.1 · A permission refusal on creating the recipient inbox directory escapes the link-refused classification, so recovery and engine open still die one directory above the hard link

- **Order:** 30
- **Scope:** `src/v1/messages.ts` (`linkOnce`, `completeFanout`), `src/v1/artifacts.ts` (`linkFailure`, `LINK_REFUSALS`), [04-protocol](../../reference/04-protocol.md) § Engine
- **Created:** 2026-09-09
- **Dependencies:** PB-65

## Context

Finding of the PB-65 review (isolated reviewer, run `pb-run-0909-t20260909-132344`), from the source, not measured. `linkOnce` (`src/v1/messages.ts`, around line 108) calls `mkdirSync(path.dirname(to), { recursive: true })` BEFORE the `try` that turns a `linkSync` errno into a classified `PromptobusError('link-refused', …)` through `linkFailure`. A permission refusal on creating `inbox/<participant>` — for example `inbox/` without the execute bit, or a read-only parent — therefore escapes as a raw errno: `completeFanout` throws, `recoverTask` (which after PB-65 catches only the classified `link-refused`) lets it through, and `recover()` at `bus()` open still takes every store command down — the failure PB-65 removed for the hard link, one directory higher. The PB-65 regression does not reach this path: it does `chmodSync(box, 0o500)` on an existing inbox directory, and a recursive `mkdir` on an existing directory does not fail.

04-protocol.md keeps the taxonomy narrow on purpose ("does not broaden the filesystem refusal taxonomy"), and PB-65's "Out of scope" forbids extending `LINK_REFUSALS`. So this is a separate decision.

Hypothesis, to verify with a fixture: a store whose `inbox/` directory is `0o500` and whose recipient directory does not exist yet → `openEngine` through `bus()` throws on every command after PB-65.

## Work to do

- Decide whether directory creation for a recipient ref belongs under the same classification as the link (the environmental conditions are the same family: EACCES, EPERM, EROFS) or under its own code. If the same: move the `mkdirSync` inside the classified `try` in `linkOnce`, or classify it with the same `linkFailure` list plus `EROFS`. If its own: a second code in `RecoverFailure.code`.
- A regression: `inbox/` at `0o500`, recipient directory absent, one pending intent → `openEngine({ recover: true })` returns, the failure appears in `failed`, `status`/`history`/`prune` exit 0; the intent is retained.
- State the rule in 04-protocol.md § Engine beside the PB-65 paragraph.

## Out of scope

- Extending `LINK_REFUSALS` for the link itself — PB-65 left it as is by design.

## Verification

- The regression above is red on the PB-65 tree and green after the repair.

## Triage — 2026-09-10

- **Track:** S — Store integrity and public engine.
- **Priority:** P1 — `recover()` at `bus()` open still takes every store command down on this path.
- **Evidence level:** source review at `3ccdf27`: `src/v1/messages.ts:109-118` — `mkdirSync` runs before the `try` that classifies `linkSync`; `src/v1/artifacts.ts:164-182` — `LINK_REFUSALS` and `linkFailure`. The hypothesis was not run.
- **Decision:** the same classification as the link. Move the `mkdirSync` inside the classified `try` in `linkOnce`, so a directory-creation refusal whose errno is in `LINK_REFUSALS` (EPERM and EACCES among them) is `link-refused` and the intent is retained for a later pass; `LINK_REFUSALS` itself is not extended — EROFS stays outside, as PB-65 left it for the link. No second `RecoverFailure` code.
- **Next step:** implement with the regression as written; isolated review.
