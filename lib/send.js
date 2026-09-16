import { ok, info, fail } from './util.js';
import { hostOf } from './host.js';
import { ensureWarden } from './warden.js';
import {
  addressesOf, bus, foreignSession, isAddress, MESSAGE_TYPES, ORCHESTRATOR, readTask,
  resolveIdentity, resolveTaskId, sendMessage, sessionIdentity, taskOwner,
} from './store.js';

// Write one bus message from the command line. There is no `--from`, and every way of
// naming a sender is PROVED before use — [03-cli.md § Send](../docs/reference/03-cli.md#send--built-not-published), ADR-011.
export function send(rootOrHost, { task, to, type = 'status', body, artifact } = {}, { env = process.env, cwd = process.cwd() } = {}) {
  const host = hostOf(rootOrHost);
  const identity = resolveIdentity(env, cwd, { host });
  const home = identity.home;
  // After the resolve, not before: the home this command writes to is the resolved one,
  // and priming the host's own would open a second store for nothing.
  bus(home, { cli: host.version });
  const session = sessionIdentity(env);
  const id = resolveTaskId(home, task ?? identity.declaredTask, session, {
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  });
  const known = addressesOf(readTask(home, id));
  const route = `Task ${id} participants: ${known.join(', ')}`;
  // Everything the caller typed is checked HERE: the store's own refusals are bare
  // `Error`s, and the catch above prints a stack a person reading a typo does not need.
  if (!to) fail(`name the recipient address: ${route}`);
  if (!isAddress(to)) fail(`«${to}» is not an address — orchestrator, worker:<slug>, reviewer:<slug> or approver:<slug>. ${route}`);
  if (!known.includes(to)) fail(`task ${id} has no participant «${to}» — nobody to deliver to. ${route}`);
  if (!String(body ?? '').trim()) fail(`the message body is empty — a message with nothing in it is not a message. ${route}`);
  if (!MESSAGE_TYPES.includes(type)) fail(`«${type}» is not a message type — one of ${MESSAGE_TYPES.join(', ')}. ${route}`);
  const from = senderOf(host, home, id, identity, env, session);
  const sent = sendMessage(home, id, { from, to, type, body, artifactPath: artifact ?? null, session }, {
    status: host.busCommand(['status']),
  });
  ok(`sent ${type} → ${to} · from ${from} · task ${id} · id ${sent.message.id}`);
  if (sent.artifact) info(`artifact ${sent.artifact.filename} → the task files directory`);
  // The listener, as on every other write path on the bus: a message nobody is watching
  // for waits until its addressee happens to take a turn.
  ensureWarden(home, id, { env, host });
  return 0;
}

/** The address this process may write from, or a refusal: a declared `PROMPTOBUS_ROLE` is
 * a CLAIM checked against the task, and a task with no owner is refused (ADR-011). */
function senderOf(host, home, id, identity, env, session) {
  const declared = String(env?.PROMPTOBUS_ROLE ?? '').trim();
  const role = declared ? identity.role : ORCHESTRATOR;
  const hint = `${host.busCommand(['status', `--task ${id}`])} shows who this task belongs to`;
  if (!session) {
    fail('this process cannot name its own session, so no sender it claims can be checked. '
      + `Run it where the bus set the identity: ${hint}`);
  }
  if (role !== ORCHESTRATOR) {
    if (!addressesOf(readTask(home, id)).includes(role)) {
      fail(`PROMPTOBUS_ROLE names «${role}», which is not a participant of task ${id} — `
        + `a role is a claim, and this one does not match the task. ${hint}`);
    }
    const held = foreignSession(home, id, role, session);
    if (held) {
      fail(`«${role}» of task ${id} is held by session ${held}, and this one is ${session} — `
        + `writing as it would borrow that address. ${hint}`);
    }
    return role;
  }
  const owner = taskOwner(home, id);
  if (!owner) {
    fail(`task ${id} records no owner, so nothing can prove this process is its ${ORCHESTRATOR}. `
      + `Declare the participant this process is with PROMPTOBUS_ROLE. ${hint}`);
  }
  if (owner !== session) {
    fail(`task ${id} belongs to session ${owner}, and this one is ${session} — writing as `
      + `${ORCHESTRATOR} would borrow that address. ${hint}`);
  }
  return ORCHESTRATOR;
}
