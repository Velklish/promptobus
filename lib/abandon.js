// Retire a participant whose harness reports the session dead and who has no Stop receipt.
// [reference/03-cli.md#status-done-sweep-dismiss-history-prune](../docs/reference/03-cli.md#status-done-sweep-dismiss-history-prune)
import { ok, info, fail } from './util.js';
import { hostOf } from './host.js';
import {
  addressOf, addressesOf, ORCHESTRATOR, ownerRoute, ownership, participantOf, readTask,
  resolveTaskId, sessionIdentity, unprovenOwnerLine, upsertParticipant, withTaskLock,
} from './store.js';
import { driverOrLift, snapshotOf } from './drivers.js';
import { participantSession, sessionReportedDead, unknownWhy } from './status.js';
import { abandonmentAllowsClose } from './native-lifecycle.js';

function whyUnknown(participant) {
  const sessions = snapshotOf([participant]);
  return unknownWhy(participant, sessions, driverOrLift(participant));
}

function reasonOf(participant) {
  const sessions = snapshotOf([participant]);
  const view = sessions?.[addressOf(participant)];
  return view?.stall?.reason || view?.note || 'the harness reports the session dead';
}

export function abandon(rootOrHost, { task, address } = {}) {
  const host = hostOf(rootOrHost);
  const home = host.promptobusHome();
  const session = sessionIdentity();
  const id = resolveTaskId(home, task, session, {
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  });
  const own = ownership(home, id, ORCHESTRATOR, session);
  const meta = readTask(home, id);
  if (!own.allowed) {
    fail(`${unprovenOwnerLine(home, meta, own)}: a participant is abandoned by the task mailbox owner. `
      + `${host.busCommand(['abandon'])} records that the session is already dead and lets ${host.busCommand(['done'])} close the task — `
      + `a foreign hand would cut off live work. ${ownerRoute(home, meta, own, host.busCommand(['abandon']))}`);
  }
  if (meta.adapter?.bb) {
    fail(`task ${id} uses BB lifecycle; abandon cannot retire its participants`);
  }
  const known = addressesOf(meta);
  const route = `${host.busCommand(['abandon', '[<address>]', `--task ${id}`])}. Task participants: ${known.join(', ')}`;
  const named = address ? participantOf(meta, address) : null;
  if (address && !named) fail(`task ${id} has no participant "${address}" — nobody to abandon. ${route}`);
  const targets = address ? [named] : meta.participants;
  const retired = [];
  const skipped = [];
  const alive = [];
  for (const participant of targets) {
    const addr = addressOf(participant);
    if (abandonmentAllowsClose(participant, sessionReportedDead(participant))) {
      if (address) {
        ok(`${address} was already abandoned — journal untouched`);
        return 0;
      }
      skipped.push(addr);
      continue;
    }
    const state = participantSession(participant);
    if (state === 'alive') {
      alive.push(addr);
      continue;
    }
    if (state !== 'dead') {
      if (address) {
        fail(`participant ${addr}: its session state could not be read — ${whyUnknown(participant)}. `
          + `Nothing was abandoned. ${route}`);
      }
      skipped.push(addr);
      continue;
    }
    const written = withTaskLock(home, id, () => {
      const current = participantOf(readTask(home, id), addr);
      if (!current || participantSession(current) !== 'dead') return false;
      if (abandonmentAllowsClose(current, true)) return true;
      const abandoned = {
        at: new Date().toISOString(),
        by: session,
        unknown: ['stop-receipt'],
        reason: reasonOf(current),
      };
      upsertParticipant(home, id, {
        ...current,
        metadata: { ...current.metadata, abandoned },
      });
      return true;
    });
    if (written) retired.push(addr);
    else alive.push(addr);
  }
  if (alive.length) {
    fail(`abandon refused live sessions: ${alive.join(', ')}. Nothing was written for them. `
      + `Retired: ${retired.join(', ') || 'none'}. A live session is closed with ${host.busCommand(['stop'])} first.`);
  }
  if (!retired.length && address) {
    ok(`${address} was already abandoned or already has a Stop receipt — journal untouched`);
    return 0;
  }
  if (retired.length) {
    ok(`abandoned ${retired.join(', ')} in task ${id} — the journal names the missing Stop receipt and does not invent one`);
  } else {
    info(`nothing to abandon in task ${id}: no participant has a session its harness reports dead`);
  }
  if (!address && skipped.length) {
    info(`left untouched: ${skipped.join(', ')} — already terminal, or the harness could not be asked`);
  }
  info(`${host.busCommand(['done', `--task ${id}`])} closes the task. A worktree whose work is not in the default branch stays.`);
  return 0;
}
