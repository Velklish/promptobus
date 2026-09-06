# PB-130 · src/index.ts's internal-helpers boundary is not enforced against lib/, so writeFileAtomic, writeJsonAtomic, shellQuote and pidAlive each have a second body inside the same npm package, and one has already drifted

- **Scope:** `src/index.ts`, `src/fs/atomic.ts`, `src/fs/proc.ts`, `src/hooks.ts`, `lib/util.js`, `lib/store.js`, `lib/cursor-persist.js`, `lib/codex-session.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`src/index.ts:7-10` states the rule: "Raw filesystem helpers (atomic file and JSON writes) do not go out — they are internal: a helper exported once becomes a contract", and `src/fs/atomic.ts:3-5` asserts "There is no second copy". Re-verified against the current tree: `writeFileAtomic` exists at `src/fs/atomic.ts:18` (mode only) and again at `lib/util.js:107` (adds a `preserveMode` option, `lib/util.js:97-105`) — the two bodies have already drifted, and the fix that added `preserveMode` never reached the `src/` copy. `writeJsonAtomic` is a 3-line wrapper duplicated at `src/fs/atomic.ts:39-42` and `lib/store.js:1013-1016`, with `lib/store.js:1011-1012`'s own comment saying "the task store writes its own files itself, inside the package; it does not export this primitive" — a policy applied against the package's own dist. `shellQuote` is character-for-character identical between `src/hooks.ts:23-25` and `lib/util.js:90-94`, including the `SHELL_SAFE` regex. `pidAlive` is the sharpest case: it is already exported publicly (`src/index.ts:57`, `export { pidAlive } from './fs/proc.js';`), `lib/store.js:56` already imports that exact export from `../dist/index.js`, and yet `lib/cursor-persist.js:292-299` and `lib/codex-session.js:138-145` each define their own byte-identical local `pidAlive` instead of importing the one `lib/store.js` already uses — so for `pidAlive` the internal/external boundary the rule defends is already crossed, and the remaining two bodies are plain copy-paste with no boundary argument behind them at all. `grep -c "from '../dist/index.js'"` shows 11 files under `lib/` already import from `../dist/index.js` (`done.js`, `drivers.js`, `harness-home.js`, `liftoff.js`, `models.js`, `spawn.js`, `warden.js`, `server.js`, `review.js`, `status.js`, `store.js`), so "lib/ must not depend on dist" is not the practice today.

## Work to do

- Fold `preserveMode` into the one `writeFileAtomic` in `src/fs/atomic.ts` (the two bodies are otherwise the same primitive) and export it, `writeJsonAtomic`, and `shellQuote` from the package (a dedicated internal-but-published entry, or `.` where `pidAlive` already goes out).
- Delete the lib copies of `writeFileAtomic`, `writeJsonAtomic`, and `shellQuote` in `lib/util.js` and `lib/store.js`; import the package versions instead.
- Delete the two local `pidAlive` bodies in `lib/cursor-persist.js` and `lib/codex-session.js` and import it from `../dist/index.js` the way `lib/store.js` already does.
- Rewrite the comment at `src/index.ts:7-10` to say what it actually protects — external consumers of the published package — since as written it reads as forbidding intra-package reuse, which the codebase does not practice.

## Out of scope

- No new abstraction beyond what already exists in `src/fs/*` — this only removes the lib-side reimplementations and gives `preserveMode` one home.
- The 11 existing `lib/*.js` files that already import from `../dist/index.js` are not touched beyond the pidAlive de-duplication.

## Verification

- `npm test` stays green (atomic-write and shell-quoting behavior is exercised indirectly by the CLI test suite).
- `grep -rn "function writeFileAtomic\|function writeJsonAtomic\|function shellQuote\|function pidAlive" lib/ src/` shows exactly one definition of each, not two to four.
