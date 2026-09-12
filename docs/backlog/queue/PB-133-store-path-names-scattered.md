# PB-133 · Store directory and path names are re-assembled outside src/v1/layout.ts in five places — the store root, the task lock, the history walk, the files/ folder, and the record-id timestamp — so each has a second home nothing keeps in step

- **Order:** 300
- **Scope:** [reference/01-overview](../../reference/01-overview.md), `src/v1/layout.ts`, `src/host.ts`, `src/standalone.ts`, `src/sidecar.ts`, `src/v1/store.ts`, `src/v1/messages.ts`, `src/migrate.ts`, `src/legacy-store.ts`, `lib/store.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Five independent instances of the same pattern, each re-verified against the current tree:

1. **Store root.** `src/v1/layout.ts:11` — `export const ROOT_DIR = '.promptobus';`. `src/host.ts:314` — `export function homeOfRoot(root: string, rel = '.promptobus'): string` — its own literal in the default parameter; `src/host.ts` imports only `node:path`, not `ROOT_DIR`. `src/standalone.ts` has six more occurrences of the literal (`:26` as `ROUTING_HOME`, `:164, 166, 183, 193-196, 214`) covering three different subjects — the store home, the account-scoped routing home, and a plugin/hook/manifest prefix — under one spelling. `docs/reference/01-overview.md:24` has to name two functions (`layout.ts` `ROOT_DIR` and `host.ts` `homeOfRoot`) to describe what should be one name, and `homeOfRoot` — the one `src/standalone.ts:138` actually uses — does not import the constant it duplicates.
2. **Task lock.** `src/v1/layout.ts:55-57` — `lockDir(home, task)` returns `path.join(taskDir(home, task), '.lock')`, used by the engine's `withTaskLock` (`src/v1/store.ts:99-105`). `src/sidecar.ts:363-370` defines a second, same-named exported `withTaskLock` that independently builds `path.join(taskDir(home, id), '.lock')` from protocol.ts's `taskDir`, not layout.ts's. `grep -rn "withTaskLock" test/*.mjs` finds no test that asserts the two implementations resolve to the same directory for one `(home, id)`. Four production sites in `lib/store.js` (`:523, 571, 605, 682`) take the sidecar lock and then call engine writes (`patchParticipant`/`putParticipant`/`patchTask`) inside it — the mutual exclusion between an adapter read-modify-write and an engine write rests on the two path expressions staying byte-identical, with nothing enforcing that.
3. **History walk.** `src/v1/messages.ts:515` — `const root = path.join(taskDir(home, task), 'history');` — re-glues a segment `src/v1/layout.ts:96-98`'s `historyDir` already owns, and there is no `historyRoot(home, task)` in layout.ts for this per-task walk. The `readdirSync` at `:517-521` is inside a `try/catch` that silently `continue`s, so a rename in `layout.ts` alone would make `history()` return an empty page rather than fail.
4. **`files/` folder.** `src/migrate.ts:676` — `const files = path.join(taskDir(temp, id), 'files');` — and `lib/store.js:778` — `return path.join(taskDir(home, id), 'files');` — both bare literals. Every sibling task-directory name has a builder in `src/v1/layout.ts` (`messagesDir`, `intentsDir`, `inboxDir`, `historyDir`, `brokenInboxDir`/`brokenArtifactsDir`/`brokenMessagesDir`, `blobsDir`, `artifactsDir`) — `files/` does not, despite `docs/reference/01-overview.md:40` calling it "the folder a person opens" and `test/promptobus-migration.test.mjs:281` asserting the same literal a third time.
5. **Record-id timestamp.** The compact-stamp transform `.toISOString().replace(/[-:.]/g, '').replace('Z', '')` — the format record ids sort by — is spelled out verbatim at `src/migrate.ts:458`, `src/migrate.ts:640`, `src/legacy-store.ts:504`, and the production send path `src/v1/messages.ts:97`, with no shared helper.

Grepped `docs/backlog/{queue,active,deferred,triage}` and `docs/archive` for `ROOT_DIR`, `homeOfRoot`, `lockDir`, `historyRoot`, `filesDir`, and `compactStamp` — none tracked.

## Work to do

- Import `ROOT_DIR` in `src/host.ts` and use it as the default for `homeOfRoot`; in `src/standalone.ts` give the three subjects that currently share the `.promptobus` literal three named constants.
- Export `lockDir` from `src/v1/layout.ts` (or a dedicated internal path module) and have `src/sidecar.ts:366` call it instead of re-gluing the segment via protocol.ts's `taskDir`; add one test asserting both `withTaskLock` implementations resolve to the same directory for one `(home, id)`.
- Add `historyRoot(home, task)` to `src/v1/layout.ts` beside `historyDir` and call it from `history()` in `src/v1/messages.ts`.
- Add `filesDir(home, task)` to `src/v1/layout.ts` beside `artifactsDir` and call it from `src/migrate.ts:676` and `lib/store.js:778`.
- Move the compact-stamp transform into one exported helper (e.g. `compactStamp(at)` next to the id builders in `src/v1/model.ts`) and call it from all four sites.
- Update `docs/reference/01-overview.md:24` to name the store root as one constant once `homeOfRoot` reads it, rather than describing two independent functions.

## Out of scope

- No behavior change for any of the five paths today — every pair of expressions currently evaluates to the same string; this only gives each concept one writer.
- The legacy-store and migration copies of the compact stamp are not deleted outright even though two of the four sites are migration-only code — folding them into the shared helper is in scope, removing the legacy code path itself is not.

## Verification

- `npm test` stays green, including `test/promptobus-migration.test.mjs:281` (the `files/` path) and the new `withTaskLock` parity test.
- `grep -rn "'\.promptobus'" src/` returns one occurrence (the `ROOT_DIR` declaration) instead of eight.
- `grep -rn "replace(/\[-:.\]/g" src/` returns one occurrence (the new helper) instead of four.

## Triage — 2026-09-07

- **Track:** X — Deferred structural work.
- **Priority:** P3.
- **Evidence level:** source/definition review at `1e0401a`, including `src/v1/layout.ts:11`, `src/host.ts:314`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.

## Returned to the queue, 2026-09-12

**The return condition has fired:** blocker `PB-101` and the store contract fixes are archived, so the bounded layout cleanup can be scheduled.
