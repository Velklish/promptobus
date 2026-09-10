# PB-84 · lib/cli.js help text still says an unflagged spawn routes nothing and models defaults to balanced, though effectiveStrategy already routes both by the recorded workspace default first

- **Order:** 760
- **Scope:** [reference/03-cli](../../reference/03-cli.md) § Model routing, `lib/cli.js`, `lib/models.js`
- **Created:** 2026-09-06
- **Dependencies:** PB-60

## Context

`lib/cli.js:56-58` (spawn block, verified verbatim against HEAD cc1aca8 with `grep -n`): '--model, --effort and --harness stay CONSTRAINTS on that choice and are never replaced. Without --strategy nothing is routed and the command takes today's path.' `lib/cli.js:70` (models block): '--strategy defaults to balanced, --role to worker.' Both sentences are unconditional, and `node bin/promptobus.js help` prints them exactly as quoted today.

The code they describe contradicts both. `effectiveStrategy()` (`lib/models.js:491-509`) returns `{ strategy: flag, source: 'flag' }` when `--strategy` is given, otherwise reads `merged.policy?.defaults?.strategy` from the merged overlay stack, and returns `null` — the unrouted legacy path — only when no layer names one. `spawn` (`lib/models.js:398`) and `review` (`lib/review.js:520`) both call it before every lift, so a recorded default routes an unflagged call. `models` with no `--strategy` (`lib/models.js:921-922`) computes `effectiveStrategy(...) ?? { strategy: DEFAULT_STRATEGY, source: null }`, and `DEFAULT_STRATEGY = 'balanced'` (`lib/models.js:50`) sits BELOW the recorded default in that chain, not ahead of it.

This is live on this machine, not hypothetical: the workspace's writable overlay `~/AtiWorkspace/workspace/.promptobus/model-routing.json` holds `{"schemaVersion":1,"defaults":{"strategy":"balance"}}` today (re-read just now), so an unflagged `spawn` here routes under `balance` and an unflagged `models` answers for `balance` — while the help claims nothing is routed and that the default is `balanced`.

Both reference paragraphs that actually consume `effectiveStrategy` already state the order correctly: `docs/reference/03-cli.md:106` ('Precedence: flag → overlay default → none') and the paragraph above it. PB-32 (archived) introduced `effectiveStrategy` and the recorded default, and its 'Documentation in the same pass' list in `docs/archive/PB-32-near-limit-signal-strategy-default/result.md` does not include `lib/cli.js` — a file the pass missed, not a decision it made.

`test/model-routing.test.mjs:470-476` asserts only that the help text contains the substrings `models `, `--strategy ` and `--allow-payg`; nothing in the suite checks the two sentences above, so correcting them regresses no green test.

## Work to do

- Replace the tail of the spawn block (`lib/cli.js:57-58`) so it names the two real outcomes: a recorded default (`promptobus models strategy`) routes the call, and only its absence in every layer takes today's unrouted path.
- Replace `lib/cli.js:70` so `--strategy` is described as defaulting to the effective workspace default, falling back to `balanced` only where no layer records one.
- Extend the same one-clause correction to the `review` block (`lib/cli.js:39`), which names `--strategy` without saying where its value comes from when the flag is absent.
- Point the corrected text at `effectiveStrategy` and ADR-004 rather than restating the precedence chain — the layer order and its exact wording stay owned by `docs/reference/03-cli.md` § Model routing.
- Extend the existing '--help names models, --strategy and --allow-payg' test in `test/model-routing.test.mjs` with an assertion that the spawn block's text no longer claims an unflagged call is unconditionally unrouted.

## Out of scope

- The precedence order and its documentation in `docs/reference/03-cli.md` — already correct, not touched.
- PB-32's introduction of `effectiveStrategy` and the recorded default itself — this entry only closes the one file its documentation pass missed.

## Verification

- `node bin/promptobus.js help` (or `helpText({...})` per the existing test) no longer prints an unconditional 'nothing is routed' / 'defaults to balanced' for spawn or models.
- `npm test` green, including the extended assertion in `test/model-routing.test.mjs`.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/cli.js:56`, `lib/models.js:491`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
