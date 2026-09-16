import {
  addrDir, history, lastSentAt, lastTurnAt, ORCHESTRATOR, startedOf,
} from './store.js';

// Which message types ask their recipient for an answer.
// [04-protocol.md § Message types](../docs/reference/04-protocol.md)
export const ANSWER_EXPECTED = Object.freeze(['task', 'question', 'review', 'result']);

// The word for a turn that ended owing an answer; `SILENT` is an unread mailbox.
export const UNANSWERED_MARK = 'UNANSWERED';

export function expectsAnswer(type) {
  return ANSWER_EXPECTED.includes(type);
}

// Newest of the given stamps, as it was written; unparsable ones are not stamps.
function newest(values) {
  let best = null;
  for (const value of values) {
    const at = Date.parse(String(value ?? ''));
    if (!Number.isFinite(at)) continue;
    if (best === null || at > best.at) best = { at, said: String(value) };
  }
  return best;
}

// One page of the walk below. A page rather than the whole history: the walk stops at
// the first hit, and most debts are one or two messages back.
const INBOUND_PAGE = 50;

// The last READ message to this participant that asks for an answer: the walk goes back,
// because an ordinary message after a question does not repay it. Unread has its own branch.
function lastInbound(home, task, addr) {
  try {
    const participant = addrDir(addr);
    let before;
    for (;;) {
      const page = history(home, {
        task, participant, limit: INBOUND_PAGE, before,
      });
      for (let i = page.entries.length - 1; i >= 0; i -= 1) {
        const { message } = page.entries[i];
        if (expectsAnswer(message.type)) return message.ts;
      }
      if (!page.cursor) return null;
      before = page.cursor;
    }
  } catch {
    // History that does not read is not a debt: a turn must not be held on a broken walk.
    return null;
  }
}

/** Since when this address owes an answer and has sent nothing, or `null` — it is even.
 * [03-cli.md § Guard and warden](../docs/reference/03-cli.md#guard-and-warden) */
export function answerOwedSince(home, task, addr, participant) {
  if (addr === ORCHESTRATOR) return null;
  const anchor = newest([startedOf(participant), lastInbound(home, task, addr)]);
  if (!anchor) return null;
  const sent = lastSentAt(home, task, addr);
  return sent === null || sent < anchor.at ? anchor.said : null;
}

/** The `UNANSWERED` state: a debt stands AND a turn has ended since it began — a reply
 * still being composed, and a death mid-turn, are not this. */
export function unansweredSince(home, task, addr, participant) {
  const owed = answerOwedSince(home, task, addr, participant);
  if (!owed) return null;
  const turn = lastTurnAt(home, task, addr);
  return turn !== null && turn >= Date.parse(owed) ? owed : null;
}
