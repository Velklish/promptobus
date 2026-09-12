import {
  addrDir, history, lastSentAt, lastTurnAt, ORCHESTRATOR, startedOf,
} from './store.js';

// Which message types ask their recipient for an answer. The table is the protocol's,
// not the guard's: docs/reference/04-protocol.md § Message types names it per type.
export const ANSWER_EXPECTED = Object.freeze(['task', 'question', 'review', 'result']);

// The word for a turn that ended owing an answer. It is not `SILENT`: that one is an
// unread mailbox, and the two states have opposite repairs.
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

// The last thing addressed to this participant that asks for an answer. Only what was
// READ is here — the mailbox keeps the unread, and the unread has its own guard branch.
function lastInbound(home, task, addr) {
  try {
    const { entries } = history(home, { task, participant: addrDir(addr), limit: 1 });
    const message = entries[entries.length - 1]?.message;
    return message && expectsAnswer(message.type) ? message.ts : null;
  } catch {
    // History that does not read is not a debt: a turn must not be held on a broken walk.
    return null;
  }
}

/**
 * Since when this address owes an answer and has sent nothing, or `null` — it is even.
 *
 * The debt is anchored on the LATER of two hand-overs, and the spawn is one of them: an
 * assignment arrives as the session's opening prompt, not as a bus message, so a
 * participant that never read a single message still owes its first word. Three of the
 * nine participants of the PB-203 post-mortem have no inbound bus message at all.
 *
 * Nothing is stored. The answer is computed from the canon and the journal on every call —
 * a debt counter on disk would be a new shape for `health.json` and the supervisor's
 * contract, which PB-207 puts out of scope.
 *
 * **The orchestrator owes nothing by this table, and that is a decision with a known
 * edge.** Every one of the nine recorded cases is a worker, and a `status` needs no
 * answer (PB-207) — so mechanising the orchestrator's debts would nag it for behaving
 * correctly. The edge it leaves: an orchestrator that ends a turn without answering a
 * blocking `question` is invisible to this state. 03-cli § Guard and warden carries it.
 *
 * Every OTHER address owes, and the door is the orchestrator's own address rather than a
 * list of roles: a role list would have to learn each new role, and the one it did not
 * know would fall silently out of the state instead of into it.
 */
export function answerOwedSince(home, task, addr, participant) {
  if (addr === ORCHESTRATOR) return null;
  const anchor = newest([startedOf(participant), lastInbound(home, task, addr)]);
  if (!anchor) return null;
  const sent = lastSentAt(home, task, addr);
  return sent === null || sent < anchor.at ? anchor.said : null;
}

/**
 * The `UNANSWERED` state itself: a debt stands AND a turn has ended since it began.
 *
 * The second half is what separates this from a session still composing its reply, and
 * from a session that died mid-turn — the end-of-turn mark is written by the guard on a
 * clean end and by nothing else. No mark, no verdict: a harness that does not run the
 * guard cannot be said to have ended a turn, and saying it anyway would re-merge the two
 * states PB-203 exists to separate.
 */
export function unansweredSince(home, task, addr, participant) {
  const owed = answerOwedSince(home, task, addr, participant);
  if (!owed) return null;
  const turn = lastTurnAt(home, task, addr);
  return turn !== null && turn >= Date.parse(owed) ? owed : null;
}
