# PB-121 · Codex's `prepare()` carries the prompt inside `argv`, so `promptobus spawn --dry-run --harness codex` prints `codex app-server --stdio <prompt>` — a line the mechanism never runs and that drops the prompt entirely if a person runs it, since `app-server` reads JSON-RPC from stdin, not a positional argument

- **Scope:** `lib/driver-codex.js`, `lib/spawn.js`, `lib/review.js`, `lib/codex-session.js`, [03-cli](../../reference/03-cli.md) § `--dry-run`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Verified against HEAD (v0.5.0). `lib/driver-codex.js:96`, inside `prepare()`: `argv: ['app-server', '--stdio', prompt]`. `spawn()` in the same file unpacks it right back — `lib/driver-codex.js:389`: `const prompt = plan.argv[plan.argv.length - 1];` — and stores the synthetic vector on the session record at `:416` (`argv: plan.argv`), next to the already-correct `prompt` field the record also carries. The real launch never uses it: `lib/codex-session.js:670` spawns `(record.bin, ['app-server', '--stdio'], …)` with no prompt argument — the prompt goes out later as a `turn/start` RPC parameter. `lib/spawn.js:1195` (the generic dry-run print, shared by every driver) prints `plan.argv.slice(0, -1)` plus a literal `<prompt>` placeholder: `codex app-server --stdio <prompt>`. That line is not runnable as shown, and even with a real value substituted for `<prompt>`, `app-server --stdio` reads its input over stdin as JSON-RPC — a positional prompt argument is not part of its interface and would be dropped. `lib/review.js:1029-1037`'s `retargetDiff` also depends on the synthetic argv, locating the prompt inside it by value (`plan.argv.lastIndexOf(plan.prompt)`) to retarget it on re-review — the only other functional consumer. `grep -rn '\.argv' lib/status.js lib/done.js lib/dismiss.js lib/stalls.js` finds nothing: no other file reads the stored `argv`. `test/promptobus-driver-codex.test.mjs:303-306` only regexes the substring `app-server --stdio` in the dry-run output — it does not catch that the full printed line is non-runnable. Not tracked: `grep -rniE 'argv|LaunchPlan|smuggl' docs/backlog docs/archive` returns only unrelated hits (holder-cleanup and golden-test entries that mention `argv` for a different reason).

## Work to do

- Add `prompt` as its own field on the Codex `LaunchPlan` — `review.js` already keeps `plan.prompt` beside `plan.argv` for other drivers, so the shape is not new.
- Change `driver-codex.js`'s `prepare()` to return `argv: ['app-server', '--stdio']` (no prompt) and have `spawn()` read `plan.prompt` directly instead of `plan.argv[plan.argv.length - 1]`.
- Update `review.js`'s `retargetDiff` to write the new prompt to `plan.prompt` only, dropping the `plan.argv.lastIndexOf(plan.prompt)` search.
- Let a driver optionally supply its own dry-run command-line string in `lib/spawn.js`'s print, falling back to today's `argv.slice(0, -1) + <prompt>` templating for drivers whose argv genuinely is the runnable command, so Codex's dry-run can state plainly that the prompt leaves as a `turn/start` request instead of showing a fabricated argv.

## Out of scope

- The `turn/start` prompt-delivery mechanism itself (`codex-session.js`) — unchanged; this only removes the argv-smuggling wrapper around it.
- Claude's and Cursor's dry-run prints — their argv is already the real command line their harness runs.

## Verification

- `promptobus spawn --dry-run --harness codex ...` against the sandboxed Codex stub prints a line that contains no literal `<prompt>` placeholder after `--stdio` and instead states the prompt leaves as a request.
- `test/promptobus-driver-codex.test.mjs:303-306`'s existing `/app-server --stdio/` check still passes, plus a new assertion that the printed line is free of the `<prompt>` placeholder.
- Existing re-review tests exercising `retargetDiff` stay green after the `LaunchPlan` shape change.
- `npm test` stays green.
