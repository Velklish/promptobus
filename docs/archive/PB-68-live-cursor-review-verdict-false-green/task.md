# PB-68 · The step-5 reviewer verdict in live-cursor.mjs is satisfied by the step-4c pair results already sitting unread in the orchestrator mailbox, so it goes green without the reviewer having sent anything

- **Scope:** `scripts/live-cursor.mjs`, [03-cli](../../reference/03-cli.md) § Review, [04-protocol](../../reference/04-protocol.md) § Message types
- **Created:** 2026-09-06
- **Dependencies:** none
- **Taken:** 2026-09-09

## Context

`scripts/live-cursor.mjs:464-466` decides step 5 with:

    const reviewSaid = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
      .filter((m) => m.type === 'result' && !String(m.body ?? '').includes(MARK.woke)).pop() ?? null,
    { timeoutMs: 300000 });

feeding the verdict at `:467-468` ('step 5: the Cursor reviewer report reached the orchestrator on the same bus'). `MARK.review` ('LIVE-CURSOR-REVIEW', declared `:143`) is never used anywhere in the file (`grep -n 'MARK\.' scripts/live-cursor.mjs` hits only `hello`, `skill`, `woke`, `pairA`, `pairB`).

The mailbox is never drained before step 5 runs: `glanceInbox` (`src/v1/messages.ts:721`) only lists the inbox and removes nothing, and no call in the script fetches (rather than glances) the orchestrator inbox before this point. So the earlier `type: 'result'` messages from step 4 — `pairA` (sent `:379`) and `pairB` (sent `:392`) — are still sitting unread, and neither contains `MARK.woke`. `waitFor` (`test/harness.mjs:528`) probes once BEFORE its first sleep, so the very first poll can already match one of them.

Probed with the real store (`lib/store.js`, createTask/sendMessage/glanceInbox, the four messages the script actually produces before step 5): inbox size 4; the literal step-5 predicate matches with no reviewer message present at all; matched body `"LIVE-CURSOR-PAIR-B\ndone"`. The verdict goes green with the reviewer having sent nothing.

This is the same false-green class the file's own author documented for step 4 at `:322-326` ('measured 2026-09-03: the first run gave "wake 0.0 s"') and hardened there with type + `startsWith(MARK.woke)`; step 5 was not hardened the same way.

The message field is `sender`, addrDir-normalized, not `from` — confirmed on the probe's stored JSON (`{"sender":"reviewer-live","type":"result",...}`, no `from` key; `store.addrDir('reviewer:live') === 'reviewer-live'`). The production review prompt the reviewer actually receives is a fixed template in `lib/review.js` (its communication protocol, around `:1088-1101`, tells the reviewer only to send `{to:"orchestrator", type:"result", body:"findings..."}`) — it is shared with every real `promptobus review` invocation and carries no per-call hook for a marker, so `MARK.review` cannot be threaded into it without leaking a live-test string into real reviews.

The file's own header (`:20-30`) states the run checks that the reviewer half is exercised ('that the reviewer deny holds', among other things) — a silently-green step 5 regardless of reviewer behaviour contradicts that stated contract. Not caught elsewhere: `live-cursor.mjs` is hand-driven by design (not in `npm test`, per its header), and it is the only live check of the Cursor reviewer half — the header explains why `live-e2e.mjs --harness cursor` cannot substitute. The sibling script's matchers (`scripts/live-mixed.mjs:345, :391` — `m.from === REVIEWER`, PR-B-60 in this same batch) have the mirror defect on the current message shape and must not be copied here — they would produce a false RED (300s timeout) instead.

## Work to do

- Match by sender instead of by absence of a marker: `m.sender === store.addrDir(REVIEWER) && m.type === 'result'`. Sender alone already removes the false green, since every other `result` message in this run's mailbox at that point comes from the worker, not the reviewer.
- Do not add `MARK.review` to the shared production review prompt in `lib/review.js` — it is a fixed template used by every real `promptobus review` run and has no per-call hook for a test-only marker; a stronger check than sender+type would have to come from something specific to this script's own harness invocation, not from the shared prompt.
- Do not reuse `scripts/live-mixed.mjs`'s `m.from === REVIEWER` idiom when fixing this — on the current message shape that field does not exist and the predicate would never match.

## Out of scope

- Adding a test-only marker to the production review prompt template in `lib/review.js` — rejected above as disproportionate; step 5 is fixed with sender+type alone.
- scripts/live-mixed.mjs's `m.from` defect — separate finding (PR-B-60 in this batch), opposite failure mode (false red, not false green).

## Verification

- Re-run this finding's probe (createTask/sendMessage/glanceInbox with the four pre-step-5 messages) against the corrected predicate: it no longer matches without a reviewer-sent message present.
- One live `node scripts/live-cursor.mjs` run: step 5 stays green when the reviewer genuinely reports, and would go red rather than silently green if the reviewer step were skipped or its message misrouted.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `scripts/live-cursor.mjs:464`, `src/v1/messages.ts:721`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
