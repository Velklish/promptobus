import { ok, info, fail } from './util.js';
import { hostOf } from './host.js';
import {
  addressesOf, approverHere, dismissParticipant, ORCHESTRATOR, ownerRoute, ownership, readTask,
  resolveTaskId, sessionIdentity, unprovenApproverLine, unprovenOwnerLine,
} from './store.js';

// Stop watching a finished participant.
// [reference/03-cli.md#dismiss--stop-watching-a-finished-participant](../docs/reference/03-cli.md#dismiss--stop-watching-a-finished-participant)
export function dismiss(rootOrHost, { task, address } = {}) {
  const host = hostOf(rootOrHost);
  const home = host.promptobusHome();
  const id = resolveTaskId(home, task, sessionIdentity(), {
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  });
  // The proof `sweep` and `stop` share: the task mailbox owner, or an approver of this task
  // holding its own recorded session — 03-cli § The owner gate.
  const session = sessionIdentity();
  const own = ownership(home, id, ORCHESTRATOR, session);
  const meta = readTask(home, id);
  // Refusal prints via `fail()`, not a throw: a stack in a human refusal is noise.
  if (!own.allowed && !approverHere(meta, session)) {
    const approver = unprovenApproverLine(meta, session);
    fail(`${unprovenOwnerLine(home, meta, own)}: a participant is dismissed by the task mailbox owner `
      + 'or by an approver of this task holding its own recorded session. '
      + 'Reports about them go to that owner, and a foreign hand would stop them for the wrong recipient. '
      + `${approver ? `${approver} ` : ''}${ownerRoute(home, meta, own, host.busCommand(['dismiss']))}`);
  }
  const known = addressesOf(meta);
  const route = `${host.busCommand(['dismiss', '<address>', `--task ${id}`])}. Task participants: ${known.join(', ')}`;
  if (!address) fail(`name the participant address: ${route}`);
  // The orchestrator is dismissed in words only: reports about them are addressed to
  // them, so a mark would record work where nothing changed.
  if (address === ORCHESTRATOR) {
    fail(`${ORCHESTRATOR} is not dismissed from watch: there are no reports about them — they are addressed to them. `
      + `Dismiss a task participant. ${route}`);
  }
  // A foreign address is refused by the record's own reply, not by a pre-check: under
  // the lock the answer is precise — the journal can change between read and write.
  const { found, was } = dismissParticipant(home, id, address);
  if (!found) fail(`task ${id} has no participant "${address}" — nobody to dismiss. ${route}`);
  if (was) {
    ok(`${address} was already dismissed from watch ${was} — journal untouched`);
    return;
  }
  ok(`${address} dismissed from watch in task ${id} — no more reports about their session to the orchestrator`);
  info('reports already sent are not recalled: dismiss speaks only of future ones');
  info('the mailbox stays: writing to a dismissed address is legal, and a new assignment to the same address'
    + ` (${host.busCommand(['spawn'])}, ${host.busCommand(['review'])}, re-review of a live session) puts them back under watch on its own`);
}
