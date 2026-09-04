import { ok, info, fail } from './util.js';
import { hostOf } from './host.js';
import {
  promptobusHome, addressesOf, claimRoute, dismissParticipant, foreignTaskLine, ORCHESTRATOR, ownership, readTask,
  resolveTaskId, sessionIdentity,
} from './store.js';

// Stop watching a finished participant.
//
// The subject is its own, not a branch of `done` or `status`: closing a task sweeps the
// whole run, and printing state only reads — dismiss changes one participant's journal
// and is done mid-run, on every slice acceptance.
//
// What dismiss does and does not do:
//
// - **stops future warden reports** about this address — one filter, in
//   `blockedParticipants` ([status.js](status.js)), and all three channels go through it:
//   the warden postcard and the line in tool replies. Postcards already sent are not
//   recalled;
// - **does not touch the mailbox.** Writing to a dismissed address is legal: the address
//   stays a participant, and the message waits for either a live session `mailbox` or a
//   participant raised again. Refusing a `result` would be a lost message where the
//   mechanism promises delivery;
// - **does not stop the session or close the task** — both commands stay with the person
//   and `promptobus done`.
export function dismiss(rootOrHost, { task, address } = {}) {
  const host = hostOf(rootOrHost);
  const home = promptobusHome(host.workspaceRoot(), host);
  const id = resolveTaskId(home, task);
  // Same owner gate as `promptobus done`: dismiss changes another run's journal, and the
  // reports it stops go to the mailbox owner. Silence when identity is unknown and on a
  // task with no owner is shared by the whole gate.
  const own = ownership(home, id, ORCHESTRATOR, sessionIdentity());
  // Refusal prints via `fail()`, not a throw: a stack in a human refusal is noise.
  if (own.gated) {
    fail(`${foreignTaskLine(readTask(home, id), own)}: a participant is dismissed by the task mailbox owner. `
      + 'Reports about them go to that owner, and a foreign hand would stop them for the wrong recipient. '
      + `${claimRoute('promptobus dismiss')}`);
  }
  const meta = readTask(home, id);
  const known = addressesOf(meta);
  const route = `${host.busCommand(['dismiss', '<address>', `--task ${id}`])}. Task participants: ${known.join(', ')}`;
  if (!address) fail(`name the participant address: ${route}`);
  // The orchestrator is dismissed only in words: there are no reports about them and
  // there cannot be — they are addressed to the orchestrator. A mark would mean work
  // done where nothing changed.
  if (address === ORCHESTRATOR) {
    fail(`${ORCHESTRATOR} is not dismissed from watch: there are no reports about them — they are addressed to them. `
      + `Dismiss a worker or a reviewer. ${route}`);
  }
  // A foreign address is rejected by the record's own reply (`found`), not by a pre-check
  // against the list: under the lock the answer is more precise — the journal can change
  // between read and write.
  const { found, was } = dismissParticipant(home, id, address);
  if (!found) fail(`task ${id} has no participant "${address}" — nobody to dismiss. ${route}`);
  if (was) {
    ok(`${address} was already dismissed from watch ${was} — journal untouched`);
    return;
  }
  ok(`${address} dismissed from watch in task ${id} — no more reports about their session to the orchestrator`);
  info('reports already sent are not recalled: dismiss speaks only of future ones');
  info('the mailbox stays: writing to a dismissed address is legal, and a new assignment to the same address'
    + ' (promptobus spawn, promptobus review, re-review of a live session) puts them back under watch on its own');
}
