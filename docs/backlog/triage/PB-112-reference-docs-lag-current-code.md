# PB-112 · docs/reference lags the code in three places at once — the protocol reference omits the whole store/fan-out/recovery contract (documented instead, in Russian, in the consumer repo), half of PromptobusHost's members are folded into prose instead of named, and the task-layout tree omits four directories a person is sent to by name elsewhere in these same docs

- **Scope:** [01-overview](../../reference/01-overview.md), [02-host](../../reference/02-host.md), [04-protocol](../../reference/04-protocol.md), `src/host.ts`, `src/v1/layout.ts`, `src/v1/messages.ts`, `src/host-index.ts`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Four sub-findings, all re-verified now against current HEAD (v0.5.0), not the finders' snapshot.

1. Protocol reference incomplete and duplicated elsewhere: `docs/reference/04-protocol.md` is still 43 lines (`wc -l`), covering addresses, message types, `openEngine`, participant metadata, artifacts, claim — nothing about store layout, fan-out, recovery, the runtime validators, or the fault-injection seam. `INTENT_STALE_MS` (`src/v1/messages.ts:139`, `= 30_000`) appears nowhere under promptobus `docs/` or `README.md` (`grep -rn INTENT_STALE`), but is documented and gated from the consumer repo instead: `/Users/kim.p/AtiWorkspace/workspace/repos/agent-workspace/ati-agents/docs/reference/14-promptobus-v1.md` (181 lines, Russian), whose line 103 carries the quoted value checked by `ati-agents/cli/lib/lint.js:284` (`'intent-stale-ms': [String(INTENT_STALE_MS / 1000)]`).
2. `docs/reference/02-host.md` (95 lines) names 23 of `PromptobusHost`'s 49 members and folds the other 26 into five prose bullets. Re-counted directly from `src/host.ts:184-304`: 44 methods plus 5 readonly identity fields (`kind`, `id`, `commandName`, `version`, `locale`) = 49 total. Checked each of the 44 method names against the current doc text: 26 are absent — `busArgv`, `busCommand`, `busHookRel`, `cloneHint`, `collectRules`, `defaultBranch`, `extraEnv`, `formatCandidate`, `formatCommand`, `formatNpx`, `freshenRepo`, `inWorkspace`, `installManifestRel`, `isClone`, `liveRunNote`, `moduleNote`, `pluginManifestRel`, `pluginSkillsRel`, `repoAbsPath`, `reportFresh`, `resolveRepoModule`, `reviewSkillDir`, `skillsDir`, `substituteVars`, `toolsManifestRel`, `workerPreamble` — an exact match to the original count.
3. `docs/reference/01-overview.md`'s task-layout tree (lines 28-38) lists `task.json`, `messages/`, `intents/`, `inbox/`, `history/`, `blobs/`, `artifacts/`, `files/` but omits `broken/inbox`, `broken/artifacts`, `broken/messages` (`src/v1/layout.ts:109-119`), `.lock` (`layout.ts:56`), and the `intents/<id>.owner` lease file (`src/v1/messages.ts:640-656`). `grep -rn broken docs/reference/*.md README.md` finds no hit about this directory. `src/v1/engine.ts:159,276` exposes `brokenPath()` for exactly this, and `src/sidecar.ts:351` tells a person to "Delete the lock directory if the writing process is already gone" — a path the layout tree never shows.
4. Same file's entry-point table, `01-overview.md:14`, calls `src/host-index.ts`'s `./host` export "Host contract only", but `host-index.ts:9` still re-exports `createStandaloneHost` from `./standalone.js`, and both `README.md:192` and `README.ru.md:191` tell consumers to `import { createStandaloneHost } from 'promptobus/host'`. `src/index.ts:102` (the `.` entry) also re-exports it, so the table's `./host` row is wrong on the one distinction ADR-002 exists to draw.

## Work to do

- Move the store/fan-out/recovery/validation/fault-injection sections from `ati-agents/docs/reference/14-promptobus-v1.md` into `docs/reference/04-protocol.md`, in English; leave a pointer the other way in the ati-agents doc; re-point `ati-agents/cli/lib/lint.js`'s `intent-stale-ms` contract-quote gate at the promptobus copy
- Replace `02-host.md`'s five summary bullets with a table naming every `PromptobusHost` member (name, signature, meaning of a null/absent answer), or pin the list against `src/host.ts` with a doc test the way `test/promptobus-package.test.mjs` already pins the version line in `01-overview.md`
- Add `broken/inbox`, `broken/artifacts`, `broken/messages`, `.lock`, and `intents/<id>.owner` to `01-overview.md`'s task-layout tree, one line each on who writes them and when they're safe to delete
- Fix `01-overview.md:14`'s table cell for `./host` to "Host contract and the standalone implementation"

## Out of scope

- Changing ADR-002 or the actual module boundary between `.` and `./host` — this only corrects what the table says about it
- Any change to `INTENT_STALE_MS`'s value or the fan-out protocol itself — this is a documentation move, not a behavior change

## Verification

- `docs/reference/04-protocol.md` documents store layout, fan-out, recovery, and `INTENT_STALE_MS`'s value with a contract marker `ati-agents`'s lint can check
- Every one of `PromptobusHost`'s 49 members (`src/host.ts:184-304`) appears by name in `docs/reference/02-host.md`
- `docs/reference/01-overview.md`'s task-layout tree lists every directory `src/v1/layout.ts` declares
- `docs/reference/01-overview.md:14`'s `./host` row matches `src/host-index.ts`'s actual exports
