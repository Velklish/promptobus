# PB-148 · LIMIT_DETAIL's alternation order makes the "limit resets" capture unreachable whenever "hit your ... limit" starts earlier in the line, so a late-start refusal naming both is filed as manual_exhaustion

- **Order:** 180
- **Scope:** [reference/03-cli](../../reference/03-cli.md) § Model routing (Claude Code: what its adapter asks — the late-start hook, ~line 412), `lib/driver-claude.js`, `test/model-routing-adapter-claude.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** PB-119

## Context

`lib/driver-claude.js:320` — `const LIMIT_DETAIL = /\bhit your\b[^\n]*\blimit\b|(\blimit\b[^\n]*\bresets\b)/i;`, read by `markLimitAtStart` (`driver-claude.js:354-357`) as `const named = Boolean(hit[1]);`, and turned into the reason at the call to `markExhausted` a few lines below: `named ? 'subscription_exhausted' : 'manual_exhaustion'`. Both the code's own comment (`driver-claude.js:333-335`: 'Which alternation matched chooses the code: the harness saying the limit RESETS makes it the subscription's limit') and `docs/reference/03-cli.md:412` ('Which half of that pattern matched chooses the code: the harness saying the limit resets makes the exhaustion the subscription's, subscription_exhausted') describe the intended contract identically — but a regex alternation is leftmost-first BY POSITION, not by which branch is 'about' the reset. When a line contains both phrases and 'hit your ... limit' begins earlier in the string, the first (uncaptured) alternative wins the match and `hit[1]` is `undefined` regardless of whether a 'resets' phrase appears later in the same line.

Probed directly against the literal regex copied from the file (`/private/tmp/.../scratchpad/probe.mjs`): `"You've hit your usage limit. Your limit resets at 3pm."` → matches `"hit your usage limit. Your limit"`, group 1 `undefined`, `named === false`. `"You've hit your weekly limit\nYour limit resets Sunday"` → `named === false`. Only when the 'resets' phrase is the ONLY one present, or physically precedes any 'hit your ... limit' phrase, does `named === true` — e.g. `"Claude usage limit reached · limit resets at 9pm"` (no 'hit your' present at all) → `named === true`.

Not caught by the suite: `node --test test/model-routing-adapter-claude.test.mjs` is green (confirmed today, no other failures). Its two late-start cases (`test/model-routing-adapter-claude.test.mjs:913-937`) feed the two wordings DISJOINTLY — `"Claude usage limit reached — you've hit your weekly limit."` (no 'resets' at all → `manual_exhaustion`) and `"Your limit resets at 3pm."` (no 'hit your' at all → `subscription_exhausted`) — never both in one string, which is exactly the case that breaks. `sessionStall` (`driver-claude.js:412`, `LIMIT_DETAIL.test(said)`) only asks whether a limit was mentioned at all and is unaffected by which alternative wins.

Consequence is real but narrow: `resetAt` is written as `null` on both branches and both reasons are sticky (only `--clear-exhausted` lifts either — `docs/reference/03-cli.md:135`, `:414`), so the routing outcome does not change. Only the recorded `reason` code in the availability cache and the one sentence appended to the refusal are wrong for this input shape. The real Claude Code refusal wording has never been captured live — `docs/archive/PB-15-claude-availability-adapter/result.md` states 'the late-start pattern rests on stubs only'.

## Work to do

- Decide the two facts separately instead of by which alternative of one pattern wins: keep `LIMIT_DETAIL` (or an equivalent) as the 'is this a limit at all' gate for `sessionStall`, and test the reset phrase independently for `named` — e.g. `const named = /\blimit\b[^\n]*\bresets\b/i.test(said);` computed regardless of where 'hit your ... limit' appears in the same string.
- Add the missing unit case to `test/model-routing-adapter-claude.test.mjs`: one refusal string containing both 'hit your ... limit' and 'limit ... resets' wording must land on `subscription_exhausted`.
- Update the comment at `lib/driver-claude.js:333-335` and `docs/reference/03-cli.md:412` to describe the corrected mechanism (whether the reset phrase is present, not which alternation matched).

## Out of scope

- Capturing the real Claude Code refusal wording — PB-15's result.md already notes this was never measured live; this entry fixes the unreachable branch for the wordings the suite already claims to cover, and does not grow into guessing further real-world phrasings.
- `sessionStall`'s use of the pattern — it only needs `.test()` and is unaffected by this change.

## Verification

- New test: a refusal string with both phrasings (e.g. "You've hit your weekly limit. Your limit resets at 3pm.") sets `entry.reason === 'subscription_exhausted'` after `markLimitAtStart`.
- The two existing disjoint-wording tests (`test/model-routing-adapter-claude.test.mjs:913-937`) keep passing unchanged.
- `node --test test/model-routing-adapter-claude.test.mjs` green.

## Triage — 2026-09-07

- **Track:** D — Harness registries and Cursor / Claude drivers.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/driver-claude.js:320`, `test/model-routing-adapter-claude.test.mjs:913`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
