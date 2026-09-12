# PB-127 · Comments across lib/, src/ and test/ still cite files and gates that live only in consumer-cli' CLI, so a promptobus-only reader who follows them finds nothing

- **Order:** 190
- **Scope:** [reference/01-overview](../../reference/01-overview.md) (already cites the correct home for one of these pairs), `lib/worktree.js`, `lib/spawn.js`, `lib/driver-claude.js`, `lib/drivers.js`, `lib/status.js`, `lib/contract.js`, `src/protocol.ts`, `src/mcp/tools.ts`, `src/fs/proc.ts`, `src/v1/messages.ts`, `test/hygiene.mjs`, `test/sandbox.mjs`, `test/run.mjs`, `scripts/audit-public.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Verified against current HEAD (v0.5.0). Two classes of dead citation:

**Files that exist only in consumer-cli.** `lib/worktree.js:33` ("key in VALUE_HOMES of lint.js"), `:37` ("shared with fresh.js and zone.js" — the ceilings actually come from `./util.js` in this repo), `:73` ("key `branch-changed-mark` in lint.js"), `:85` ("fresh.js determines it"), `:338` ("key in VALUE_HOMES of lint.js"); `lib/spawn.js:56` ("a test holds the match with `OWNED_SETTINGS_KEYS` in plugin.js" — `test/promptobus-spawn.test.mjs:72-74` only asserts `SKILL_KEYS.includes('skillOverrides')`, no such cross-file match exists); `lib/driver-claude.js:212` ("headless.js"), `:214` ("smoke.js"), `:697` ("guardhook.js"); `lib/drivers.js:10` lists `doctor` among "the other bus modules" — `grep -n "case '" lib/cli.js` shows the real subcommand set has no `doctor` and no `lint`; `lib/status.js:141` and `src/protocol.ts:184` both cite "lint.js" for the contract-quote gate. `find . -name 'lint*'` outside `node_modules` and worktrees returns nothing in this repo; `lint.js`, `plugin.js`, `doctor.js`, `fresh.js`, `zone.js`, `headless.js`, `smoke.js`, `guardhook.js` all exist under `/Users/kim.p/AtiWorkspace/workspace/repos/agent-workspace/consumer-cli/cli/lib/`. The gate is real (`consumer-cli/cli/lib/lint.js:270-273`, `VALUE_HOMES` at `:787-790`) but checks ATI's documentation, not this package's — `docs/reference/*.md` and `README.md` here quote none of these marks today, so nothing is broken yet, but the comments promise a guard this repository does not have.

**Test files that exist only in consumer-cli.** `test/run.mjs:187,194` (`fresh.test.mjs`), `:189` (`zone.test.mjs`), `:208` (`promptobus.test.mjs`), `:279` (`setup.test.mjs`); `test/hygiene.mjs:46-47` (`root.test.mjs`, `cli-flags.test.mjs`, `setup.test.mjs`); `test/sandbox.mjs:75` (`exec.test.mjs`), `:227` (`doctor.test.mjs`). `ls test/*.test.mjs` in promptobus has none of these eight names; all eight exist under `consumer-cli/cli/test/`. These are load-bearing citations, not decoration — e.g. `hygiene.mjs:46-48` justifies why the HOME swap is shared rather than per-file by naming three files that are not here, so the argument cannot be checked in this repository.

**Two related, more specific misattributions in the same class.** `src/mcp/tools.ts:3-6` and `lib/contract.js:8` both say the second `PROMPTOBUS_TOOLS` copy is checked by "lint" — this package has no lint script (`package.json` has only `lint:backslop`, which lints backslop task documents); the actual guard is a live test, `test/promptobus-mcp.test.mjs:195`. `docs/reference/01-overview.md:48` already states the correct fact ("Declared in `src/mcp/tools.ts` and listed in `lib/contract.js`"), so the fix in `tools.ts`/`contract.js` should match it. `src/fs/proc.ts:1-3` says `pidAlive` "goes out from `store.ts`" — `grep -rn "pidAlive" src/` shows it going out from `src/index.ts:57` and `src/legacy-store.ts:775`; `src/v1/store.ts` neither imports nor exports it. `src/v1/messages.ts:135-138` says the reference and `lint` live "outside" without naming them — the reference is `consumer-cli/docs/reference/14-promptobus-v1.md:103` and the gate is `consumer-cli/cli/lib/lint.js:284`; its claim of "no other consumers outside" is also stale — `lib/store.js:51` re-exports `INTENT_STALE_MS` with no reader inside `lib/`.

`scripts/audit-public.mjs` exists and catches leaked names and markdown links, but not backticked bare filenames — confirmed by the fact these citations survived the extraction. Not already tracked: `docs/archive/PB-2.3-sandbox-cites-a-check-that-does-not-exist` fixed one earlier instance of this exact defect class in `test/sandbox.mjs` (a different citation, `homedir-module.test.mjs`), and `docs/archive/PB-22-audit-link-check-reads-code-spans` twice deferred "widening the checker to catch [bare filenames]" as a separate, noisier question. Neither closes the citations named here, and `test/sandbox.mjs:75`'s live `exec.test.mjs` reference proves the defect class recurs even after PB-2.3 fixed one case.

## Work to do

- Rewrite each dead citation: where the fact lives in this repo, name the actual file (`guardhook.js` → `src/hooks.ts`; `fresh.js`/`zone.js` → `./util.js`); where the gate lives only in consumer-cli, reword to describe it generically without a bare filename (e.g. "the consumer CLI's contract-quote gate reads this value through the package") for `lint.js`/`plugin.js`/`doctor.js`/`headless.js`/`smoke.js` mentions and the eight dead test-file names.
- Fix `src/mcp/tools.ts:3-6` and `lib/contract.js:8` to name `lib/contract.js` and `test/promptobus-mcp.test.mjs:195` instead of "the consumer" and "lint".
- Fix `src/fs/proc.ts:1-3` to name `src/index.ts`/`src/legacy-store.ts`, and `src/v1/messages.ts:135-138` to name the consumer-cli reference file and lint key explicitly; drop the unread `INTENT_STALE_MS` re-export from `lib/store.js:51` unless a consumer is expected soon.
- No automated gate in this pass: `scripts/audit-public.mjs`'s deferred "catch bare filenames" widening (PB-2.3, PB-22) stays an open question for the owner, not required work here — this entry is prose-only.
- No CHANGELOG entry: comment-only corrections, no behaviour change.

## Out of scope

- Extending `scripts/audit-public.mjs` to flag arbitrary bare filenames in `lib/**`/`test/**` — the owner explicitly deferred exactly that twice (PB-2.3, PB-22) as its own, noisier question; this entry does not decide it.
- Porting the consumer-cli contract-quote gate into this repository — a much larger change than the prose fix, and not required to make the comments honest.

## Verification

- `grep -rn "lint\.js\|plugin\.js\|doctor\.js\|fresh\.js\|zone\.js\|headless\.js\|smoke\.js\|guardhook\.js" lib/ src/ test/` (excluding `dist/`) returns nothing, or only mentions with a correct local pointer.
- `grep -rn "fresh.test.mjs\|zone.test.mjs\|promptobus.test.mjs\|setup.test.mjs\|root.test.mjs\|cli-flags.test.mjs\|exec.test.mjs\|doctor.test.mjs" lib/ src/ test/` returns nothing.
- `grep -n "pidAlive" src/fs/proc.ts` shows the corrected file names; `grep -n "lint" src/v1/messages.ts` names the consumer-cli reference explicitly.

## Triage — 2026-09-07

- **Track:** X — Deferred structural work.
- **Priority:** P3.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/worktree.js:33`, `lib/spawn.js:56`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.

## Returned to the queue, 2026-09-12

**The return condition has fired:** the runtime tracks are integrated. **Check first whether the finding is still live:** `PB-172` (the self-documenting-code sweep) is archived and removed comments across the tree, so some of the dead citations this card lists may already be gone. Re-measure before rewriting anything.
