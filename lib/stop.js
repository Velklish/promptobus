// Stop ONE participant's session and leave the task open. Why a verb of its own rather
// than a flag on `done` or `dismiss`: ADR-012, and 03-cli § Status, done, dismiss…
import { ok, info, warn, fail } from './util.js';
import { hostOf } from './host.js';
import {
  addressesOf, foreignTaskLine, ORCHESTRATOR, ownership, participantOf, readTask,
  resolveTaskId, sessionIdentity,
} from './store.js';
import {
  driverFor, harnessOf, isManaged, snapshotSessions, stopParticipant,
} from '../dist/index.js';
import { REGISTRY, driverOrLift } from './drivers.js';
import { participantSession } from './status.js';

export async function stop(rootOrHost, { task, address } = {}, { registry = REGISTRY } = {}) {
  const host = hostOf(rootOrHost);
  const home = host.promptobusHome();
  const id = resolveTaskId(home, task, sessionIdentity(), {
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  });
  // The same owner gate as `done` and `dismiss`: this closes a session the mechanism started
  // for THIS run, and a foreign hand would take a worker off work somebody else is watching.
  const own = ownership(home, id, ORCHESTRATOR, sessionIdentity());
  if (own.gated) {
    fail(`${foreignTaskLine(readTask(home, id), own)}: a participant session is stopped by the `
      + 'task mailbox owner — the session belongs to their run.');
  }
  const meta = readTask(home, id);
  const known = addressesOf(meta);
  const route = `${host.busCommand(['stop', '<address>', `--task ${id}`])}. Task participants: ${known.join(', ')}`;
  if (!address) fail(`name the participant address: ${route}`);
  // The orchestrator has no session the bus lifted — it is the session that lifted the others —
  // so there is nothing here to stop, and a "stopped" line would be a lie.
  if (address === ORCHESTRATOR) {
    fail(`${ORCHESTRATOR} has no session this mechanism started — it is the one that started `
      + `the others. Stop a worker or a reviewer. ${route}`);
  }
  const p = participantOf(meta, address);
  if (!p) fail(`task ${id} has no participant "${address}" — nobody to stop. ${route}`);
  // A session the mechanism did not start is not the mechanism's to close: an attached
  // participant is a person's own window, and `spawn` never promised to own it.
  if (!isManaged(p)) {
    fail(`participant ${address} was not started by this mechanism — its session is not ours to `
      + `close. Close it yourself from ${driverOrLift(p).phrases.sessions}, or drop the watch: `
      + `${host.busCommand(['dismiss', address, `--task ${id}`])}`);
  }
  const driver = (() => {
    try {
      return driverFor(registry, harnessOf(p, registry));
    } catch {
      return driverOrLift(p);
    }
  })();
  const sessions = snapshotSessions([p], registry);
  if (participantSession(p, sessions) !== 'alive') {
    ok(`participant ${address} has no live session — nothing to stop; the task stays open`);
    info(`the watch is a separate thing: ${host.busCommand(['dismiss', address, `--task ${id}`])} stops the reports`);
    return 0;
  }
  // Named before the call, as `done` names its list: the stop is irreversible, and a person
  // reading the output should see what is closing now rather than what closed.
  info(`stopping the session of participant ${address} — the task stays open and the other participants keep working`);
  const r = await stopParticipant(p, registry);
  if (!r?.ok) {
    fail(`could not close the session of participant ${address}: ${r?.note ?? 'reason unknown'} `
      + `— close it yourself from ${driver.phrases.sessions}`);
  }
  if (r.attempted && !r.stopped) {
    // Not reported as success: the record may still say the session is alive, and that is the
    // exact state this door exists to stop leaving behind.
    warn(`stop of the session of participant ${address} was not confirmed: ${r.note} — its record `
      + `may still read alive; check ${driver.phrases.sessions}`);
    return 1;
  }
  // The driver's own `stop` retires the session record with the process. A hand `kill` is what
  // leaves one reading `alive`, and calling the driver instead of a person's `kill` is the point.
  if (r.stopped) ok(`session of participant ${address} closed: ${r.note}`);
  else ok(`participant ${address} had no session to stop: ${r.note}`);
  info(`task ${id} stays active; ${host.busCommand(['status'])} shows who is still in it`);
  info('the watch is untouched — reports about this address stop with '
    + `${host.busCommand(['dismiss', address, `--task ${id}`])}, and its mailbox keeps working`);
  return 0;
}
