# PB-147 · The remove seam added to removeJournals/sweepJournals so its deletion-refusal branch could be tested has no caller — that branch and the "journals not removed" warning are untested

- **Scope:** [reference/03-cli](../../reference/03-cli.md) § Status, done, dismiss, history, prune, `lib/prune.js`, `lib/done.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`lib/prune.js:103-105` (comment directly above the function): 'remove is a seam for the suite: there is no portable way to make a directory undeletable (chmod on Windows does not forbid deletion, and under root it forbids nowhere), and the refusal branch would otherwise stay untested.' `lib/prune.js:106` — `function removeJournals(home, dead, { days, young, remove = rmSync })`; `lib/prune.js:138` — `export function sweepJournals(home, days = PRUNE_DEFAULT_DAYS, { remove } = {})`, which threads `remove` through only when truthy (`lib/prune.js:142`).

`grep -rn "sweepJournals|removeJournals|remove:" lib/ test/` (excluding `node_modules`) finds exactly two callers and no test override: `lib/done.js:385` — `sweepJournals(home)`, no options object at all — and `lib/prune.js:177` — `removeJournals(home, dead, { days, young })` (the hand-run `prune` command), also with no `remove` override. No test file passes `{ remove: ... }` to either function, and there is no dedicated prune test file (`find test -iname '*prune*'` returns nothing).

The seam therefore has no caller anywhere — not in production code (where a real, portable failure has no way to be constructed, by the comment's own account) and not in the suite (where the seam exists precisely to let a test construct one). Two branches are consequently unexercised: `lib/prune.js:113-116` (`catch { failed += 1; warn('task … not removed: …') }`) and the all-failed line at `lib/prune.js:122` (`warn('journals not removed: none of N tasks came off (refusals M) — reason for each is the line above')`), along with the `count = dead.length - failed` arithmetic (`lib/prune.js:117`) that decides whether the green or yellow line prints. Today's only prune coverage is indirect happy-path: `test/promptobus-done.test.mjs:280-320` (the `SWEEP_*` fixtures, asserting the green `journals removed: tasks 1` line) and `test/scenario.mjs:1176-1188` (`prune --older-than 0 --yes`) — neither injects a failure.

The reachable production path is real: `promptobus prune` deletes journals irreversibly, and `promptobus done` calls `sweepJournals` automatically on every close (`reference/03-cli.md` § Status, done, dismiss, history, prune: 'Journals of tasks closed more than PRUNE_DEFAULT_DAYS (14) days ago are removed on that last call'). An `rmSync` that throws for a real reason — permission denied, a busy handle, a race with another process — hits this exact catch on a destructive command's failure path.

## Work to do

- Add a prune test (new `test/promptobus-prune.test.mjs`, or extend `test/promptobus-done.test.mjs`) exercising `sweepJournals`/`removeJournals` with `{ remove: throwingFn }`: one case where some `dead` tasks fail deletion (assert `failed`, `count`, the per-task 'task X not removed' warn line, and that the green line still fires when `count > 0`), and one where every task fails (assert the yellow 'journals not removed: none of N tasks came off' line, and that nothing is claimed removed).
- If review judges the branch not worth a direct test after all, remove the `remove` injection seam from both signatures and call `rmSync` directly instead — record that decision in the same pass rather than leaving an unused seam.

## Out of scope

- Any change to the deletion or warning behaviour itself — this is a coverage gap, not a defect in what `removeJournals` does today.
- The `prune` command's other paths (active-task refusal, held-directory detection) — already covered by existing tests.

## Verification

- New test(s) green: `sweepJournals(home, days, { remove: () => { throw new Error('x'); } })` reports `failed` and `count` correctly, and the corresponding warn lines print.
- `node --test test/promptobus-done.test.mjs` (and the new file, if separate) stays green; `node test/run.mjs` for the full suite unaffected.
