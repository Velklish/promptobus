# PB-90 · A Codex reviewer's routed effort is never sent to the harness — review/start and thread/start carry no effort field — so it runs at the account's default while status and telemetry still name the routed level

- **Scope:** `lib/codex-session.js` (the `review/start`/`turn/start` fork), `lib/driver-codex.js` (`EFFORT_LEVELS`), `lib/review.js` (`resolveEffort`, `effortNote`), `models/catalog.json` (`codex-sol-xhigh`, `codex-sol-max`), [reference/03-cli.md](../../reference/03-cli.md) § Participant telemetry
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

The Codex holder's first RPC call forks by role, and only the worker branch carries an effort (lib/codex-session.js:992-1002):

```
const first = record.role === 'reviewer'
  ? await rpc.request('review/start', {          // 993
    threadId: state.threadId,
    target: { type: 'custom', instructions: record.prompt },
    delivery: 'inline',
  }, TURN_STARTED_TIMEOUT_MS)
  : await rpc.request('turn/start', {            // 998
    threadId: state.threadId,
    ...(record.effort ? { effort: record.effort } : {}),   // 1000
    input: [{ type: 'text', text: record.prompt }],
  }, TURN_STARTED_TIMEOUT_MS);
```

Checked against the installed binary's own protocol (codex-cli 0.146.0, `codex app-server generate-json-schema`): `v2/ReviewStartParams.json` has exactly three properties — `delivery`, `target`, `threadId` — no `effort`; `v2/ThreadStartParams.json` (built at `lib/codex-session.js:953-961` for `thread/start`) has `model`, `sandbox`, `approvalPolicy`, `config`, but no `effort` either. So a Codex reviewer's routed effort has nowhere to go on either RPC call it makes over its whole life — the participant runs at whatever `model_reasoning_effort` the local account config already holds.

(The worker path is NOT part of this finding: `v2/TurnStartParams.json` documents `effort` as overriding "this turn **and subsequent turns**", so the effort sent once on the worker's first `turn/start` persists across every later wake on the same thread — `activate`'s own `turn/start` call, `lib/driver-codex.js:284-291`, correctly sends none.)

The value is nonetheless collected and believed all the way to the reviewer's own status line, despite never being sent: validated against `EFFORT_LEVELS` (`lib/driver-codex.js:43`), resolved from the routed tuple (`resolveEffort(routed.effort ?? undefined, driver)`, `lib/review.js:429`), stored on the record (`lib/driver-codex.js:404`, `effort: plan.settings?.effort ?? null`), and printed as applied by `effortNote` (`lib/review.js:823-824`, `plan.effort ? \` · effort: ${plan.effort}${notApplied(plan)}\` : ''` — its `notApplied` caveat fires only on a re-review, not on a fresh Codex lift). The same value lands in the telemetry record's `effort` field, which `docs/reference/03-cli.md:643` calls "what actually ran".

`models/catalog.json` makes this reachable rather than theoretical: `codex-sol-xhigh` (quality 9, clearing the reviewer's quality floor of 9) and `codex-sol-max` both carry `"roles": ["worker", "reviewer"]`, so both are eligible for a routed Codex reviewer pick today.

Codex is the outlier among the three drivers here: Claude puts `--effort` in argv (`lib/driver-claude.js:689`, unaffected by role) and Cursor bakes the level into the model id (`lib/driver-cursor.js:404`), so for both of them a reviewer keeps the requested level for its whole session. `lib/review.js:619-621` already comments that a diverged version gate "would leave the reviewer silently sitting on default effort" — the same failure mode this finding reports, for effort rather than for the version gate.

## Work to do

- Measure first, against the proven binary: send `thread/start` with `config: { mcp_servers: …, model_reasoning_effort: <level> }` (`config` is the open passthrough object the driver already uses for `mcp_servers`, `lib/codex-session.js:958`, and `model_reasoning_effort` is a documented ConfigToml key of this binary) and confirm the thread actually takes the level — read it back via `thread/read` or watch for a `ThreadSettingsUpdatedNotification`.
- If it holds: move the effort into `startParams` (`lib/codex-session.js:953-961`) for both roles, and drop the per-turn spread at line 1000 — one source of truth, and `review/start` needs no change since the thread already carries it.
- If it does not hold: the protocol cannot honour a reviewer effort at all — refuse `--effort` for a Codex reviewer the way `lib/driver-claude.js:762-769` refuses `ultracode`, and drop `reviewer` from `roles` on the Codex tuples in `models/catalog.json` so the resolver stops routing a level it cannot deliver.
- A test next to the existing Codex checks in `test/promptobus-driver-codex.test.mjs` asserting the effort lands wherever the chosen fix puts it, so the worker and reviewer branches cannot diverge again silently.
- Update `docs/reference/03-cli.md` to say explicitly whether a Codex reviewer's effort is honoured or refused, whichever branch is taken.

## Out of scope

- The worker path's effort handling — confirmed correct as-is (`effort` in `turn/start` persists across wakes per the protocol's own schema).
- `turn/steer` — the driver never calls it, and its schema carries no `effort` property either.

## Verification

- A one-off live probe against codex-cli 0.146.0 confirming whether `thread/start`'s `config.model_reasoning_effort` takes effect — this decides which of the two work-items applies.
- The new test in `test/promptobus-driver-codex.test.mjs` passes.
- `npm test` stays green.
